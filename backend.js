const config = require("./config.js");
const { DynamoDBClient, ScanCommand, DeleteCommand, UpdateCommand } = require("@aws-sdk/client-dynamodb");
const OAuth = require("oauth");

const dynamoDb = new DynamoDBClient({ region: config.aws_region });

exports.handler = async function (event, context) {
  const params = {
    TableName: config.table_name,
    Limit: 1,
  };

  try {
    const result = await dynamoDb.send(new ScanCommand(params));
    if (result.Items[0]) {
      const jobId = result.Items[0].jobId.S;
      let tweet_ids = result.Items[0].tweet_ids.L.map(id => id.S);
      const to_delete_list = tweet_ids.splice(0, config.delete_per_run);
      const twitter_token = result.Items[0].token.S;
      const twitter_secret = result.Items[0].secret.S;

      if (tweet_ids.length === 0) {
        const deleteParams = {
          TableName: config.table_name,
          Key: { jobId: { S: jobId } },
        };
        await dynamoDb.send(new DeleteCommand(deleteParams));
        console.log("Item Deleted - " + jobId);
      } else {
        const updateParams = {
          TableName: config.table_name,
          Key: { jobId: { S: jobId } },
          UpdateExpression: "set tweet_no = :n, tweet_ids = :l",
          ExpressionAttributeValues: {
            ":n": { N: tweet_ids.length.toString() },
            ":l": { L: tweet_ids.map(id => ({ S: id })) },
          },
        };
        await dynamoDb.send(new UpdateCommand(updateParams));
        console.log("Item Updated - " + jobId + ":" + tweet_ids.length);
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

      for (let i = 0; i < to_delete_list.length; i++) {
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
  } catch (error) {
    console.error("Unable to scan item:", error);
  }
};
