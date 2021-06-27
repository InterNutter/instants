const fs = require('fs');
const express = require('express');
const moment = require('moment');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const session = require('express-session');
const fileStore = require('session-file-store')(session);
const { Issuer, generators } = require('openid-client');

const configData = fs.readFileSync('config.json', {encoding: 'utf8'});
const config = JSON.parse(configData);
const listen = config.listen || '0.0.0.0'; 
const port = config.port || 3000; 
const dbFile = config.dbFile || 'story.db';
const apiURL = config.apiURL || 'http://localhost:3000';
const websiteURL = config.siteURL || 'http://localhost:8080';
const oauthURL = config.oauthURL || 'http://localhost:4031';
const oauthClient = config.oauthClient || 'test';
const oauthSecret = config.oauthSecret || 'secret';
const sessionSecret = config.sessionSecret || 'secret';

const app = express();
const db = new sqlite3.Database(dbFile);

const callback = `${apiURL}/callback`;

let norgIssuer, norgClient;

let norgConnect = Issuer
    .discover(oauthURL)
    .then((issuer) => {
        norgIssuer = issuer;
        norgClient = new norgIssuer.Client({
            client_id: oauthClient,
            client_secret: oauthSecret,
            redirect_uris: [callback],
            response_types: ['code'],
        });
    })
    .catch((err) => {
        console.error('Failed to discover auth issuer', err);
        process.exit(1);
    });

function getRandomIntInclusive(min, max) {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min + 1) + min); //The maximum is inclusive and the minimum is inclusive
}

app.use(cors({
    origin: [
        websiteURL,
        /^http:\/\/(127\.0\.0\.1|192\.168\.\d+\.\d+):\d+$/,
    ],
    credentials: true,
    methods: ['GET', 'POST'],

}));
app.use(express.json());
app.set('trust proxy', 1);
app.use(session({
    store: new fileStore({}),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false, sameSite: 'lax' }
}));

app.get('/account', (req, res) => {
    let account = req.session.userinfo;
    if (!account) {
        account = {
            signedIn: false,
        }
    }
    else {
        account.signedIn = true;
    }
    res.send(account);
});

app.get('/callback', (req, res) => {
    const params = norgClient.callbackParams(req);
    const code_verifier = req.session.verifier;
    console.log('Code verifier',code_verifier);

    if (!code_verifier) {
        console.log('Session does not contain code verifier', req.session);
        res.status(500).send({error: 'Failed getting verifier from session'});
        return;
    }

    norgClient
        .callback(callback, params, { code_verifier })
        .then(function (tokenSet) {
            norgClient
                .userinfo(tokenSet) // => Promise
                .then(function (userinfo) {
                    req.session.userinfo = userinfo;
                    req.session.access_token = tokenSet.access_token;
                    const redirect = req.session.redirect;
                    console.log('Redirect', redirect);

                    res.status(302).location(redirect).end();
                })
                .catch((err) => {
                    console.log('Failed to get userinfo', err)
                    res.status(500).send({error: 'Failed fetching user info'});
                });
        })
        .catch((err) => {
            console.log('Failed to authenticate', err);
            res.status(500).send({error: 'Failed authenticating'});
        });
});

app.get('/sign-out', (req, res) => {
    delete req.session.userinfo;
    delete req.session.access_token;
    res.send({})
});

app.get('/sign-in', (req, res) => {
    const code_verifier = generators.codeVerifier();
    req.session.verifier = code_verifier;
    console.log('Created verifier', code_verifier);
    const redirect = req.header('referer');
    req.session.redirect = redirect;
    console.log('Redirect', redirect);

    const code_challenge = generators.codeChallenge(code_verifier);
    const url = norgClient.authorizationUrl({
        scope: 'openid email profile',
        code_challenge,
        code_challenge_method: 'S256',
    });
    res.status(302).location(url).end();
});

// get all story numbers
/*

GET /story
[1,2,3,4,5,6,7,...,3012,3013]

 */
app.get('/story', (req, res) => {
    const send = (err, rows) => {
        if (err) {
            return res.status(500).send({error: err});
        }
        // rows will look like [{number: 1},{number: 2},...]
        const storyNums = [];
        for (const row of rows) {
            storyNums.push(row.number);
        }
        return res.send(storyNums);
    }

    db.serialize(() => {
        db.all('SELECT DISTINCT number FROM stories ORDER BY number', send);
    });
});

// get a story and content
/*

GET /story/3123 -- Gets story by number.

GET /story/last -- Gets the most recent story.

 */
app.get('/story/:storyID', (req, res) => {
    const number = req.params.storyID;

    const send = (err, row) => {
        if (err) {
            return res.status(500).send({error: err});
        }
        return res.send(row);
    }

    db.serialize(() => {
        if (number === 'last'){
            // get the last story
            db.get('SELECT * FROM stories ORDER BY number DESC LIMIT 1', send);
            return;
        } else if (number === 'random') {
            db.get('SELECT max(number) last FROM stories', (err, row) => {
                if (err) {
                    return res.status(500).send({error: err});
                }
                //make a random number
                const rand = getRandomIntInclusive(1,row.last);
                db.get('SELECT * FROM stories WHERE number = ?', rand, send);
            });
            return;
        }
        db.get('SELECT * FROM stories WHERE number = ?', number, send);
    });

});

// get a tag set
/*

GET /tag/WORD -- Gets story by tag.

EG: Search tag "magical mayhem" returns

{
  n1: 'Title 1',
  n2: 'Title 2',
  ...
}

*/
app.get('/tag/:phrase', (req, res) => {
    const phrase = req.params.phrase;

    const send = (err, rows) => {
        if (err) {
            return res.status(500).send({error: err});
        }
        const stories={};
        for (const row of rows) {
            stories[row.number] = row.title;
        }
        return res.send(stories);
    };

    db.serialize(() => {
        db.all('SELECT tags.number, stories.title ' +
            'FROM tags ' +
            'LEFT JOIN stories ' +
            'ON (tags.number=stories.number) ' +
            'WHERE tag = ?', phrase, send);
    });
});

/*

GET /tags/NUMBER -- Gets the tags by story number.

['tag', 'string', 'array']

 */
app.get('/tags/:storyID', (req, res) => {
    const number = req.params.storyID;

    const send = (err, rows) => {
        if (err) {
            return res.status(500).send({error: err});
        }
        // rows will look like [{tag: 'a'},{tag: 'b'},...]
        const tagList = [];
        for (const row of rows) {
            tagList.push(row.tag);
        }
        return res.send(tagList);
    }

    db.serialize(() => {
       db.all('SELECT tag FROM tags WHERE number = ?', number, send);
    });
});

app.get('/favourites', (req, res) => {
    if (!req.session.userinfo || !req.session.userinfo.email) {
        res.status(400).send({error: 'Not logged in'});
        return;
    }
    const email = req.session.userinfo.email;

    const send = (err, rows) => {
        if (err) {
            return res.status(500).send({error: err});
        }
        // rows will look like [{tag: 'a'},{tag: 'b'},...]
        const favList = [];
        for (const row of rows) {
            favList.push(row.number);
        }
        return res.send(favList);
    }

    db.serialize(() => {
        db.all('SELECT number FROM favourites WHERE email = ?', email, send);
    });

});

//Update or post tags
/*

POST /tags/NUMBER
["tag a", "tag b", ... ]

 */

app.post('/tags/:storyID', (req,res) => {
    if (notAdmin(req, res)) return;

    const number = req.params.storyID;
    const tags = req.body;

    console.log('setting tags ', tags, ' for story ', number);

    if(!tags){
        return res.status(400).send({
            error: 'no tags provided'
        });
    }
    let failed = false;
    const done = (err) => {
        if (failed) return;
        if (err) {
            res.status(500).send( {
                error: err
            });
            failed = true;
        }
    }

    db.serialize(() => {
        db.run('DELETE FROM tags WHERE number = ?', number, done);
        db.parallelize(() => {
            for (const tag of tags) {
                db.run('INSERT INTO tags VALUES (?,?)', tag, number, done);
            }
        });
    });

    if (!failed) res.status(200).send();


});

// update or create a story
/*

POST /story
{
  "number": 3542, -- Story number, required.
  "year": 2020, -- Year number, required.
  "day": 124 -- Day of the year. Maximum 365 normally, 366 on leap years, required.
  "title": "Title Goes Here", -- Story title, required.
  "prompt": "Prompt text in markdown, potentially multiline", -- Prompt text, required.
  "content": "Story content in markdown.\nDefinitely\nMultiline", -- Content, required.
}
-- Updates a story if it exists, creates it if not.

 */
app.post('/story', (req, res) => {
    if (notAdmin(req, res)) return;

    const story = req.body;
    // if no story, then fail message
    if (!story){
        return res.status(400).send({
            error: 'no story provided'
        });
    }
    // if no story data, then fail message
    if (!story.number || !story.year || !story.day || !story.title || !story.prompt || !story.content){
        return res.status(400).send({
            error: 'incomplete story provided'
        });
    }

    // insert handler
    const insertHandler = (err,rows) => {
        if (err) {
            return res.status(500).send({
                error: err
            });
        }
        return res.send({
            message: 'new story created',
            number: story.number
        });
    }
    // query to insert a story
    const insert = () => {
        db.serialize(()=>{
           db.run('INSERT INTO stories (number, year, day, title, prompt, content) VALUES (?, ?, ?, ?, ?, ?)',
               story.number, story.year, story.day, story.title, story.prompt, story.content,
           insertHandler)
        });
    }
    // update handler to be fixed later
    const updateHandler = function (err) {
        if (err) {
            return res.status(500).send({
                error: err
            });
        }
        if (!this.changes) {
            return insert();
        }
        return res.send({
            message: 'story updated',
            number: story.number
        });
    }
    // runs query to perform update
    const update = () => {
        db.serialize(()=>{
            db.run('UPDATE stories SET year=?, day=?, title=?, prompt=?, content=? WHERE number=?',
                story.year, story.day, story.title, story.prompt, story.content, story.number,
                updateHandler)
        });
    }

    update();
});

// add tags to a database
/*
POST /tags/3123
["tag 1", "tag 2", "tag 3"]
-- Sets the tags for the given story to the supplied list
-- (overriding existing tags)
 */
app.post('/tags/:storyID', (req,res) =>{
    if (notAdmin(req, res)) return;

    const tags = req.body;
    const number = req.params.storyID;

    // handle insertion of tags
    let failed = false;
    const errorHandler = (err,rows) => {
        if (failed) return;
        if (err) {
            failed = true;
            return res.status(500).send({
                error: err
            });
        }
    }
    // query to insert a set of tags
    const save = () => {
        db.serialize(()=>{
            db.run('DELETE FROM tags WHERE number = ?', number, errorHandler);
            for (const tag of tags){
                db.run('INSERT INTO tags (tag, number) VALUES (?, ?)', tag, number, errorHandler);
            }
        });
        if (!failed){
            res.send({success:true});
        }
    }
    save();
});

app.post('/favourite', (req, res) => {
    const body = req.body;
    const number = body.number;
    const set = body.set;

    if (!req.session.userinfo || !req.session.userinfo.email) {
        res.status(400).send({error: 'Not logged in'});
        return;
    }
    const email = req.session.userinfo.email;
    let failed = false;
    const errorHandler = (err,rows) => {
        if (failed) return;
        if (err) {
            failed = true;
            return res.status(500).send({
                error: err
            });
        }
    };
    db.serialize(() => {
        if (set) {
            db.run('INSERT OR IGNORE INTO favourites (email, number) VALUES (?, ?)', email, number, errorHandler);
            return;
        }
        db.run('DELETE FROM favourites WHERE email = ? AND number = ?', email, number, errorHandler);

    });
    if (!failed) {
        res.send({success:true});
    }
});

function notAdmin(req, res) {
    if (req.session.userinfo && req.session.userinfo.email === 'admin@internutter.org') return false;

    console.log("permission denied for:", req.session.userinfo);

    res.status(300).send({
        error: `Not Permitted!`
    });
    return true;
}

(async () => {
    await norgConnect;

    app.listen(port, listen, () => {
        console.log(`Example app listening at http://${listen}:${port}`);
    });
})();
