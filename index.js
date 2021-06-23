const config = require("./config.js");
const serverless = require('serverless-http');
const express = require('express')
const AWS = require('aws-sdk');
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const oauth = require('oauth');
const util = require('util');
const path = require('path');
const fs = require('fs-extra');
const multer = require('multer');
const upload = multer({ dest: '/tmp/' });
const AdmZip = require("adm-zip");
const parser  = {
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
        config.consumer_key, config.consumer_secret, "1.0A", config.callback_url, "HMAC-SHA1");
}

app.route('/')
    .get(function (req, res, next) {
        res.render("index", {config: config}, function (err,html) {
            return res.send(html);
       });
    })

app.route('/auth')
    .get(function(req, res, next) {
        consumer().getOAuthRequestToken(function(error, token, secret, results){
            if (error) {
                res.send("Error: " + util.inspect(error), 500);
            } else {
                req.session.token  = token;
                req.session.secret = secret;
                res.redirect("https://twitter.com/oauth/authorize?oauth_token="+req.session.token);
            }
        })
    })

app.route('/callback')
    .get(function(req, res, next) {
        consumer().getOAuthAccessToken(req.session.token, req.session.secret, req.query.oauth_verifier, function(error, token, secret, results) {
            if (error) {
                res.send("Error: " + util.inspect(error) + "["+token+"]"+ "["+secret+"]"+ "["+util.inspect(results)+"]", 500);
            } else {
                req.session.token = token;
                req.session.secret = secret;
                consumer().get("https://api.twitter.com/1.1/account/verify_credentials.json", req.session.token, req.session.secret, function (error, data, response) {
                    if (error) {
                        res.send("Error: " + util.inspect(error), 500);
                    } else {
                        data = JSON.parse(data);
                        req.session.twitterScreenName = data["screen_name"];
                        res.render("callback",{session : req.session});
                    }
                })
            }
        })
    })

app.route('/upload')
    .post(upload.single('fileUploaded'), function (req, res, next) {
        if (req.file) {
            console.log(req.file);
            console.log(req.body);
            //res.redirect('/post-upload/'+req.file.filename)
            let zip = new AdmZip(req.file.path);
            let zipEntries = zip.getEntries();
            zipEntries.forEach(function (zipEntry) {
                console.log(zipEntry.toString());
                if (zipEntry.entryName == "tweet.js") {
                    console.log(zipEntry.getData().toString("utf8"));
                }
            });

            // force replace first line to [{
            /*
                        let tweet_archive = fs.readFileSync("/tmp/tweet.js").toString().split('\n');
                        tweet_archive[0] = "[{";
                        tweet_archive = tweet_archive.join('\n');
                        tweet_archive = JSON.parse(tweet_archive);
                        for(tweet in tweet_archive) {
                            res.write(tweet["tweet"]["id"]+"\n");
                        }
            */

            /*
                        const execSync = require('child_process').execSync;
                        execSync('cat /tmp/tweet.js | sed \'1 s/^.*$/[ {/\' | jq -r .[].tweet.id', (error, stdout, stderr) => {
                            if (error) {
                                console.log("Error occurs");
                                console.error(error);
                                return;
                            }
                            console.log(stdout);
                            console.log(stderr);
                        });
             */
        }
    })

app.route('/post-upload/:filename')
    .get(function (req, res, next) {
        fs.readdirSync('/tmp/').forEach(file => {
            console.log(file);
        });
    })

app.route('/job/status/:jobId')
    .get(function (req, res, next) {
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

app.route('/job/new')
    .get(function (req, res, next) {
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
