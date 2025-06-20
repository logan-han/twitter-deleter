const { DynamoDBClient, PutItemCommand, GetItemCommand } = require("@aws-sdk/client-dynamodb");
const crypto = require("crypto");

class SessionStore {
  constructor(dynamoClient, tableName) {
    this.dynamoClient = dynamoClient;
    this.tableName = tableName;
  }

  generateSessionId() {
    return crypto.randomBytes(32).toString('hex');
  }

  async saveSession(sessionId, sessionData) {
    const params = {
      TableName: this.tableName,
      Item: {
        jobId: { S: `session_${sessionId}` },
        data: { S: JSON.stringify(sessionData) },
        ttl: { N: Math.floor(Date.now() / 1000 + 3600).toString() } // 1 hour TTL
      }
    };

    try {
      await this.dynamoClient.send(new PutItemCommand(params));
      return true;
    } catch (error) {
      console.error("Error saving session:", error);
      return false;
    }
  }

  async getSession(sessionId) {
    const params = {
      TableName: this.tableName,
      Key: {
        jobId: { S: `session_${sessionId}` }
      }
    };

    try {
      const result = await this.dynamoClient.send(new GetItemCommand(params));
      if (result.Item && result.Item.data) {
        return JSON.parse(result.Item.data.S);
      }
      return null;
    } catch (error) {
      console.error("Error getting session:", error);
      return null;
    }
  }
}

module.exports = SessionStore;
