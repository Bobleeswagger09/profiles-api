const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");
const { v7: uuidv7 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// Create table on startup
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      gender TEXT,
      gender_probability REAL,
      sample_size INTEGER,
      age INTEGER,
      age_group TEXT,
      country_id TEXT,
      country_probability REAL,
      created_at TEXT NOT NULL
    )
  `);
  console.log("DB ready");
}

// Age group classifier
function getAgeGroup(age) {
  if (age <= 12) return "child";
  if (age <= 19) return "teenager";
  if (age <= 59) return "adult";
  return "senior";
}

// POST /api/profiles
app.post("/api/profiles", async (req, res) => {
  const name = req.body.name;

  // 422 — non-string
  if (name !== undefined && typeof name !== "string") {
    return res.status(422).json({
      status: "error",
      message: "Invalid type: name must be a string",
    });
  }

  // 400 — missing or empty
  if (!name || name.trim() === "") {
    return res
      .status(400)
      .json({ status: "error", message: "Missing required field: name" });
  }

  const trimmedName = name.trim().toLowerCase();

  // Idempotency — check if profile already exists
  try {
    const existing = await pool.query(
      "SELECT * FROM profiles WHERE name = $1",
      [trimmedName],
    );
    if (existing.rows.length > 0) {
      return res.status(200).json({
        status: "success",
        message: "Profile already exists",
        data: existing.rows[0],
      });
    }
  } catch (err) {
    return res.status(500).json({ status: "error", message: "Database error" });
  }

  // Call all 3 APIs in parallel
  try {
    const [genderRes, agifyRes, nationalizeRes] = await Promise.all([
      axios.get("https://api.genderize.io", {
        params: { name: trimmedName },
        timeout: 5000,
        validateStatus: () => true,
      }),
      axios.get("https://api.agify.io", {
        params: { name: trimmedName },
        timeout: 5000,
        validateStatus: () => true,
      }),
      axios.get("https://api.nationalize.io", {
        params: { name: trimmedName },
        timeout: 5000,
        validateStatus: () => true,
      }),
    ]);

    const genderData = genderRes.data;
    const agifyData = agifyRes.data;
    const nationalizeData = nationalizeRes.data;

    // Validate Genderize
    if (
      !genderData.gender ||
      genderData.gender === null ||
      genderData.count === 0
    ) {
      return res.status(200).json({
        status: "error",
        message: "No gender prediction available for the provided name",
      });
    }

    // Validate Agify
    if (agifyData.age === null || agifyData.age === undefined) {
      return res.status(200).json({
        status: "error",
        message: "No age prediction available for the provided name",
      });
    }

    // Validate Nationalize
    if (!nationalizeData.country || nationalizeData.country.length === 0) {
      return res.status(200).json({
        status: "error",
        message: "No nationality prediction available for the provided name",
      });
    }

    // Extract and process data
    const gender = genderData.gender;
    const gender_probability = genderData.probability;
    const sample_size = genderData.count;

    const age = agifyData.age;
    const age_group = getAgeGroup(age);

    // Pick country with highest probability
    const topCountry = nationalizeData.country.reduce((a, b) =>
      a.probability > b.probability ? a : b,
    );
    const country_id = topCountry.country_id;
    const country_probability = topCountry.probability;

    const id = uuidv7();
    const created_at = new Date().toISOString();

    // Store in DB
    await pool.query(
      `INSERT INTO profiles (id, name, gender, gender_probability, sample_size, age, age_group, country_id, country_probability, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        trimmedName,
        gender,
        gender_probability,
        sample_size,
        age,
        age_group,
        country_id,
        country_probability,
        created_at,
      ],
    );

    return res.status(201).json({
      status: "success",
      data: {
        id,
        name: trimmedName,
        gender,
        gender_probability,
        sample_size,
        age,
        age_group,
        country_id,
        country_probability,
        created_at,
      },
    });
  } catch (error) {
    if (error.request) {
      return res.status(502).json({
        status: "error",
        message: "External API did not respond in time",
      });
    }
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  }
});

// GET /api/profiles — list all profiles
app.get("/api/profiles", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM profiles ORDER BY created_at DESC",
    );
    return res.status(200).json({ status: "success", data: result.rows });
  } catch (err) {
    return res.status(500).json({ status: "error", message: "Database error" });
  }
});

// GET /api/profiles/:id — get one profile
app.get("/api/profiles/:id", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM profiles WHERE id = $1", [
      req.params.id,
    ]);
    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ status: "error", message: "Profile not found" });
    }
    return res.status(200).json({ status: "success", data: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ status: "error", message: "Database error" });
  }
});

app.use((req, res) => {
  res.status(404).json({ status: "error", message: "Route not found" });
});

initDB()
  .then(() => {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error("Failed to init DB:", err);
    process.exit(1);
  });
