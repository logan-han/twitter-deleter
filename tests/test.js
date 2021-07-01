const chai = require("chai");
const chaiHttp = require("chai-http");
const app = require("../index");
const { expect } = chai;

chai.use(chaiHttp);

describe("Route Checks", () => {
  describe("GET /", () => {
    it("should return 200", (done) => {
      chai
        .request(app)
        .get("/")
        .end((err, res) => {
          if (err) done(err);
          expect(res).to.have.status(200);
          expect(res).to.be.an("object");
          done();
        });
    });
  });
  describe("GET /auth", () => {
    it("should redirect to twitter auth", (done) => {
      chai
        .request(app)
        .get("/auth")
        .end((err, res) => {
          if (err) done(err);
          expect(res).to.redirect;
          expect(res).to.be.an("object");
          done();
        });
    });
  });
  describe("GET /status/test", () => {
    it("should return 404", (done) => {
      chai
        .request(app)
        .get("/status/test")
        .end((err, res) => {
          if (err) done(err);
          expect(res).to.have.status(404);
          expect(res).to.be.an("object");
          done();
        });
    });
  });
  describe("GET /callback", () => {
    it("should return 500", (done) => {
      chai
        .request(app)
        .get("/callback")
        .end((err, res) => {
          if (err) done(err);
          expect(res).to.have.status(500);
          expect(res).to.be.an("object");
          done();
        });
    });
  });
  describe("POST /upload", () => {
    it("should return 404", (done) => {
      chai
        .request(app)
        .post("/upload")
        .type("form")
        .send({
          _method: "post",
        })
        .end((err, res) => {
          if (err) done(err);
          expect(res).to.have.status(404);
          expect(res).to.be.an("object");
          done();
        });
    });
  });
});
