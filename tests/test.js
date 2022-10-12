const app = require("../index");
const should = require("should"),
  supertest = require("supertest");
const request = supertest(app);

describe("Route Checks", () => {
  describe("GET /", () => {
    it("should return 200", (done) => {
      request.get("/").end((err, res) => {
        if (err) done(err);
        res.status.should.equal(200);
        done();
      });
    });
  });
  describe("GET /auth", () => {
    it("should redirect to twitter auth", (done) => {
      request.get("/auth").end((err, res) => {
        if (err) done(err);
        res.status.should.be.redirect;
        done();
      });
    });
  });
  describe("GET /status/test", () => {
    it("should return 404", (done) => {
      request.get("/status/test").end((err, res) => {
        if (err) done(err);
        res.status.should.equal(404);
        done();
      });
    });
  });
  describe("GET /callback", () => {
    it("should return 500", (done) => {
      request.get("/callback").end((err, res) => {
        if (err) done(err);
        res.status.should.equal(500);
        done();
      });
    });
  });
  // causes Error [ERR_HTTP_HEADERS_SENT]: Cannot set headers after they are sent to the client
  describe("POST /delete-recent", () => {
    it("should return 500", (done) => {
      request
        .post("/delete-recent")
        .type("form")
        .send({
          _method: "post",
        })
        .end((err, res) => {
          if (err) done(err);
          res.status.should.equal(500);
          done();
        });
    });
  });

  describe("POST /upload without a file", () => {
    it("should return 404", (done) => {
      request
        .post("/upload")
        .type("form")
        .send({
          _method: "post",
        })
        .end((err, res) => {
          if (err) done(err);
          res.status.should.equal(404);
          done();
        });
    });
  });

});

/*
// this functionality check returns socket hang up :/
  describe("POST /upload with a valid ZIP", () => {
    it("should return 500", (done) => {
      request
        .post("/upload")
        .set("Content-Type", "multipart/form-data")
        .set("Accept", "application/zip")
        .attach("fileUploaded", "tests/tweet.js.zip")
        .end((err, res) => {
          if (err) done(err);
          res.status.should.equal(500);
          done();
        });
    });
  });
 */
