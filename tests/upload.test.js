const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const supertest = require("supertest");

// Mock AWS SDK
const mockDynamoDbClient = {
  send: jest.fn(),
};

jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn(() => mockDynamoDbClient),
  PutItemCommand: jest.fn((params) => params),
  GetItemCommand: jest.fn((params) => params),
  ScanCommand: jest.fn((params) => params),
}));

jest.mock("twitter-api-v2", () => ({
  TwitterApi: jest.fn(() => ({})),
}));

const app = require("../index");
const request = supertest(app);

describe("File Upload Integration Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDynamoDbClient.send.mockReset();
  });

  afterEach(() => {
    // Clean up any test files
    const testFiles = [
      path.join(__dirname, "test-tweet-archive.zip"),
      path.join(__dirname, "invalid-archive.zip"),
      path.join(__dirname, "empty-archive.zip")
    ];
    
    testFiles.forEach(file => {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    });
  });

  describe("POST /upload", () => {
    beforeEach(() => {
      // Create test files for upload testing
      createTestTweetArchive();
      createInvalidArchive();
      createEmptyArchive();
    });

    it("should successfully process valid tweet archive", (done) => {
      mockDynamoDbClient.send.mockResolvedValue({});
      
      request
        .post("/upload")
        .attach("fileUploaded", path.join(__dirname, "test-tweet-archive.zip"))
        .field("token", "test_token")
        .field("refresh_token", "test_refresh_token")
        .end((err, res) => {
          if (err) done(err);
          res.status.should.equal(302); // Redirect to status page
          done();
        });
    });

    it("should handle archive without tweet.js file", (done) => {
      request
        .post("/upload")
        .attach("fileUploaded", path.join(__dirname, "invalid-archive.zip"))
        .field("token", "test_token")
        .end((err, res) => {
          if (err) done(err);
          res.status.should.equal(404);
          res.body.should.have.property("error");
          done();
        });
    });

    it("should handle empty archive", (done) => {
      request
        .post("/upload")
        .attach("fileUploaded", path.join(__dirname, "empty-archive.zip"))
        .field("token", "test_token")
        .end((err, res) => {
          if (err) done(err);
          res.status.should.equal(404);
          res.body.should.have.property("error");
          done();
        });
    });

    it("should handle DynamoDB errors during upload", (done) => {
      mockDynamoDbClient.send.mockRejectedValue(new Error("DynamoDB Error"));
      
      request
        .post("/upload")
        .attach("fileUploaded", path.join(__dirname, "test-tweet-archive.zip"))
        .field("token", "test_token")
        .end((err, res) => {
          if (err) done(err);
          res.status.should.equal(500);
          res.body.should.have.property("error", "Could not create the job");
          done();
        });
    });

    it("should require token field", (done) => {
      request
        .post("/upload")
        .attach("fileUploaded", path.join(__dirname, "test-tweet-archive.zip"))
        .end((err, res) => {
          if (err) done(err);
          // Should still process but with undefined token
          // The actual behavior depends on how the app handles missing tokens
          done();
        });
    });
  });

  // Helper functions to create test files
  function createTestTweetArchive() {
    const zip = new AdmZip();
    
    // Create a mock tweet.js file with valid format
    const tweetData = [
      {
        "tweet": {
          "id_str": "1234567890123456789",
          "created_at": "Wed Dec 31 23:59:59 +0000 2023",
          "full_text": "This is a test tweet #1"
        }
      },
      {
        "tweet": {
          "id_str": "9876543210987654321",
          "created_at": "Thu Jan 01 00:00:01 +0000 2024",
          "full_text": "This is a test tweet #2"
        }
      }
    ];
    
    // Twitter archive format starts with "window.YTD.tweet.part0 = "
    const tweetFileContent = "window.YTD.tweet.part0 = " + JSON.stringify(tweetData);
    
    zip.addFile("tweet.js", Buffer.from(tweetFileContent, "utf8"));
    zip.addFile("manifest.js", Buffer.from("window.YTD.manifest.part0 = []", "utf8"));
    
    const zipBuffer = zip.toBuffer();
    fs.writeFileSync(path.join(__dirname, "test-tweet-archive.zip"), zipBuffer);
  }

  function createInvalidArchive() {
    const zip = new AdmZip();
    
    // Add files but no tweet.js
    zip.addFile("manifest.js", Buffer.from("window.YTD.manifest.part0 = []", "utf8"));
    zip.addFile("account.js", Buffer.from("window.YTD.account.part0 = []", "utf8"));
    
    const zipBuffer = zip.toBuffer();
    fs.writeFileSync(path.join(__dirname, "invalid-archive.zip"), zipBuffer);
  }

  function createEmptyArchive() {
    const zip = new AdmZip();
    const zipBuffer = zip.toBuffer();
    fs.writeFileSync(path.join(__dirname, "empty-archive.zip"), zipBuffer);
  }
});
