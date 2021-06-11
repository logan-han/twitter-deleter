const config = require("./config.js");
const serverless = require('serverless-http');
const express = require('express')
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const AWS = require('aws-sdk');
const app = express();

app.use(bodyParser.json({ strict: false }));
app.engine('html', require('ejs').renderFile);
app.set('view engine', 'html');

app.get('/', function (req, res) {
  res.render("index", {config: config}, function (err,html) {
      return res.send(html);
    });
})

app.get('/status/:jobId', function (req, res) {
    const params = {
        TableName: config.table_name,
        Key: {
            jobId: req.params.jobId,
        },
    }

    dynamoDb.get(params, (error, result) => {
        if (error) {
            console.log(error);
            res.status(400).json({ error: 'Could not get the job' });
        }
        if (result.Item) {
            const {jobId, name} = result.Item;
            res.json({ jobId});
        } else {
            res.status(404).json({ error: "job not found = completed" });
        }
    });
})

app.post('/upload', function (req, res) {
    const { jobId, filename } = req.body;
    if (typeof jobId !== 'string') {
        res.status(400).json({ error: '"jobId" must be a string' });
    } else if (typeof filename !== 'string') {
        res.status(400).json({ error: '"filename" must be a string' });
    }

    const params = {
        TableName: config.table_name,
        Item: {
            jobId: jobId,
            filename: filename,
        },
    };

    dynamoDb.put(params, (error) => {
        if (error) {
            console.log(error);
            res.status(400).json({ error: 'Could not create the job' });
        }
        res.json({ jobId, filename });
    });
})


module.exports.handler = serverless(app);
