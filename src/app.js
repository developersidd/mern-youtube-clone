// Dependencies
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import { createClient } from "redis";
import requestIp from "request-ip";
// import Routes
import commentRouter from "./routes/comment.routes.js";
import likeRouter from "./routes/like.routes.js";
import loginHistoryRouter from "./routes/loginHistory.routes.js";
import playlistRouter from "./routes/playlist.routes.js";
import subscriptionRouter from "./routes/subscription.routes.js";
import tweetRouter from "./routes/tweet.routes.js";
import userRouter from "./routes/user.routes.js";
import videoRouter from "./routes/video.routes.js";
// App Initialization
const app = express();

// Redis Cache
const connectRedis = async () => {
  const client = await createClient()
    .on("error", (err) => console.log("Redis Client Error", err))
    .connect();
  app.locals.redisClient = client;
};
connectRedis();
// Middlewares
app.use(express.json({ limit: "20kb" }));
// for parsing application/x-www-form-urlencoded data from the client side form submission (e.g., login form) and extended: true allows for nested objects in the form data
app.use(express.urlencoded({ limit: "20kb" }));
// Anything in this directory will be served up as static content.
app.use(express.static("public"));
app.use(cors({ credentials: true, origin: process.env.CORS_ORIGIN }));
app.use(cookieParser());
app.use(requestIp.mw());
// routes
app.use("/api/v1/users", userRouter);
app.use("/api/v1/videos", videoRouter);
app.use("/api/v1/likes", likeRouter);
app.use("/api/v1/playlist", playlistRouter);
app.use("/api/v1/tweets", tweetRouter);
app.use("/api/v1/comments", commentRouter);
app.use("/api/v1/subscriptions", subscriptionRouter);
app.use("/api/v1/login-history", loginHistoryRouter);

export default app;
