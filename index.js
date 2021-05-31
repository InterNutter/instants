const express = require('express')
const app = express()
const moment = require('moment')
const port = 3000
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('story.db'); // these all call the libraries that do the thing

app.use(express.json()) // for parsing application/json

app.get('/', (req, res) => {
    return res.send('Received a GET HTTP method');
});

// get a story and content
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
        }
        db.get('SELECT * FROM stories WHERE number = ?', number, send);
    });
});

app.post('/', (req, res) => {
    return res.send('Received a POST HTTP method');
});

// update or create a story
app.post('/', (req, res) => {
    const story = req.body;
    // if no story, then fail message
    if (!story){
        return res.status(400).send({
            error: 'no story provided'
        });
    }
    // if no story data, then fail message
    if (!story.title || !story.prompt || !story.content){
        return res.status(400).send({
            error: 'incomplete story provided'
        });
    }
    // if no year, a year will be provided
    if (!story.year) story.year = moment().year();


    // insert handler
    const insertHandler = (err,res) => {
        if (err) {
            return res.status(500).send({
                error: err
            });
        }
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
    const updateHandler = (err,res) => {
        if (err) {
            return insert();
        }
        return res.send({
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

app.put('/', (req, res) => {
    return res.send('Received a PUT HTTP method');
});

app.delete('/', (req, res) => {
    return res.send('Received a DELETE HTTP method');
});

app.listen(port, () => {
    console.log(`Example app listening at http://localhost:${port}`)
});