const config = require("./config.js");
const AWS = require("aws-sdk");
const OAuth = require("oauth");
const dynamoDb = new AWS.DynamoDB.DocumentClient();

exports.handler = function (event, context, callback) {
  const params = {
    TableName: config.table_name,
    Limit: 1,
  };
  dynamoDb.scan(params, (error, result) => {
    if (error) {
      console.error("Unable to scan item:", JSON.stringify(error, null, 2));
    }
    if (result.Items[0]) {
      var jobId = result.Items[0].jobId;
      var tweet_ids = result.Items[0].tweet_ids;
      var to_delete_list = tweet_ids.splice(0, config.delete_per_run);
      var twitter_token = result.Items[0].token;
      var twitter_secret = result.Items[0].secret;
      if (tweet_ids.length == 0) {
        const params = {
          TableName: config.table_name,
          Key: {
            jobId: jobId,
          },
        };
        dynamoDb.delete(params, function (error, result) {
          if (error) {
            console.error(
              "Unable to delete item:",
              JSON.stringify(error, null, 2)
            );
          } else {
            console.log("Item Deleted - " + jobId);
          }
        });
      } else {
        const params = {
          TableName: config.table_name,
          Key: {
            jobId: jobId,
          },
          UpdateExpression: "set tweet_no = :n, tweet_ids = :l",
          ExpressionAttributeValues: {
            ":n": tweet_ids.length,
            ":l": tweet_ids,
          },
        };
        dynamoDb.update(params, function (error, result) {
          if (error) {
            console.error(
              "Unable to update item:",
              JSON.stringify(error, null, 2)
            );
          } else {
            console.log("Item Updated - " + jobId + ":" + tweet_ids.length);
          }
        });
      }
      var oauth = new OAuth.OAuth(
        "https://api.twitter.com/oauth/request_token",
        "https://api.twitter.com/oauth/access_token",
        config.consumer_key,
        config.consumer_secret,
        "1.0A",
        null,
        "HMAC-SHA1"
      );
      for (i in to_delete_list) {
        oauth.post(
          "https://api.twitter.com/1.1/statuses/destroy/" +
            to_delete_list[i] +
            ".json",
          twitter_token,
          twitter_secret,
          {},
          function (error, data, response) {
            if (error) {
              console.log(error);
            }
          }
        );
      }
    }
  });
};
