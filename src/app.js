const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/authRoutes");
const uploadRoutes = require("./routes/uploadRoutes");

const app = express();

/*
|--------------------------------------------------------------------------
| CORS Configuration
|--------------------------------------------------------------------------
*/

app.use(
  cors({
    origin: process.env.FRONTEND_URL,
    credentials: true,
  })
);

/*
|--------------------------------------------------------------------------
| Body Parser
|--------------------------------------------------------------------------
*/

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/*
|--------------------------------------------------------------------------
| API Routes
|--------------------------------------------------------------------------
*/

app.use("/api/auth", authRoutes);
app.use("/upload", uploadRoutes);

/*
|--------------------------------------------------------------------------
| Home Route
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {
  res.send("Vaidyasthana Backend Running");
});

/*
|--------------------------------------------------------------------------
| 404 Route
|--------------------------------------------------------------------------
*/

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "API Route Not Found",
  });
});

/*
|--------------------------------------------------------------------------
| Error Handler
|--------------------------------------------------------------------------
*/

app.use((err, req, res, next) => {
  console.error(err);

  res.status(500).json({
    success: false,
    message: "Internal Server Error",
  });
});

module.exports = app;