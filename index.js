const config = require("./config.js");
const serverless = require('serverless-http');
const express = require('express')
const AWS = require('aws-sdk');
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const oauth = require('oauth');
const util = require('util');
var parser  = {
    cookie  : require( 'cookie-parser' ),
    body    : require( 'body-parser' ),
    session : require( 'express-session' ),
};
const app = express();

app.use(parser.body.json({ strict: false }));
app.use(parser.body.urlencoded({ extended: false }));
app.engine('html', require('ejs').renderFile);
app.set('view engine', 'html');

app.use(parser.session({
    secret            : config.consumer_secret,
    resave            : false,
    saveUninitialized : true
}));

function consumer() {
    return new oauth.OAuth(
        "https://twitter.com/oauth/request_token", "https://twitter.com/oauth/access_token",
        config.consumer_key, config.consumer_secret, "1.0A", "https://twitter.han.life/callback", "HMAC-SHA1");
}

app.get('/auth', function(req, res) {
    consumer().getOAuthRequestToken(function(error, token, secret, results){
        if (error) {
            res.send("Error getting OAuth request token : " + util.inspect(error), 500);
        } else {
            req.session.token  = token;
            req.session.secret = secret;
            res.redirect("https://twitter.com/oauth/authorize?oauth_token="+req.session.token);
        }
    })
})

app.get('/callback', function(req, res) {
    consumer().getOAuthAccessToken(req.session.token, req.session.secret, req.query.oauth_verifier, function(error, token, secret, results) {
        if (error) {
            res.send("Error getting OAuth access token : " + util.inspect(error) + "["+token+"]"+ "["+secret+"]"+ "["+util.inspect(results)+"]", 500);
        } else {
            req.session.token = token;
            req.session.secret = secret;
            consumer().get("https://api.twitter.com/1.1/account/verify_credentials.json", req.session.token, req.session.secret, function (error, data, response) {
                if (error) {
                    res.send("Error getting twitter screen name : " + util.inspect(error), 500);
                } else {
                    data = JSON.parse(data);
                    req.session.twitterScreenName = data["screen_name"];
                    res.send('You are signed in with Twitter screenName ' + req.session.twitterScreenName)
                }
            })
        }
    })
})

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
