import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import app from "../src/server";
import { prisma } from "../src/db";

describe("POST /signup", () => {
  beforeEach(async () => {
    await prisma.user.deleteMany();
  });

  it("should send 400 for any required fields missing", async () => {
    const usernameResponse = await request(app).post("/signup").send({
      password: "test-user1",
    });
    expect(usernameResponse.status).toBe(400);

    const passwordResponse = await request(app).post("/signup").send({
      username: "test-user1",
    });
    expect(passwordResponse.status).toBe(400);
  });

  it("should signup the user", async () => {
    const username = "test-user6";
    const response = await request(app).post("/signup").send({
      username,
      password: "test-user1",
    });

    expect(response.status).toBe(201);
    const newUser = response.body;
    expect(newUser).toMatchObject({
      token: expect.any(String),
      userId: expect.any(String),
      username,
    });
  });

  it("should throw 409 if duplicate username is used to create", async () => {
    const username = "test-user-1";
    await request(app).post("/signup").send({
      username,
      password: "test-user-1",
    });

    const response = await request(app).post("/signup").send({
      username,
      password: "test-user-2",
    });

    expect(response.status).toBe(409);
  });
});

describe("POST /signin", () => {
  beforeEach(async () => {
    await prisma.user.deleteMany();
  });
  it("should send 400 for any required fields missing", async () => {
    const usernameResponse = await request(app).post("/signin").send({
      password: "test-user1",
    });
    expect(usernameResponse.status).toBe(400);

    const passwordResponse = await request(app).post("/signin").send({
      username: "test-user1",
    });
    expect(passwordResponse.status).toBe(400);
  });

  it("should login with username & password for a created user", async () => {
    const username = "test-user-7";
    await request(app).post("/signup").send({
      username,
      password: "test-user1",
    });

    const response = await request(app).post("/signin").send({
      username,
      password: "test-user1",
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      token: expect.any(String),
      userId: expect.any(String),
      username,
    });
  });

  it("should return 401 if username is not found", async () => {
    const username = "test-user-1";
    await request(app).post("/signup").send({
      username,
      password: "test-user1",
    });

    const response = await request(app).post("/signin").send({
      username: "test-user-2",
      password: "test-user1",
    });

    expect(response.status).toBe(401);
  });

  it("should return 401 if password does not match", async () => {
    const username = "test-user-1";
    await request(app).post("/signup").send({
      username,
      password: "test-user1",
    });

    const response = await request(app).post("/signin").send({
      username,
      password: "test-user2",
    });

    expect(response.status).toBe(401);
  });
});
