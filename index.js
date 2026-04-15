const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// UUID v7 — time-ordered, no extra package needed
function uuidv7() {
  const now = Date.now();
  const timeHigh = Math.floor(now / 0x100000000);
  const timeLow = now >>> 0;
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);
  const hex = [
    timeHigh.toString(16).padStart(8, "0"),
    timeLow.toString(16).padStart(8, "0"),
  ].join("");
  const t1 = hex.slice(0, 8);
  const t2 = hex.slice(8, 12);
  const t3 = "7" + hex.slice(13, 16);
  const r1 =
    ((rand[0] & 0x3f) | 0x80).toString(16).padStart(2, "0") +
    rand[1].toString(16).padStart(2, "0");
  const r2 = Array.from(rand.slice(2, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${t1}-${t2}-${t3}-${r1}-${r2}`;
}

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Database
let pool;
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

async function initDB() {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      gender TEXT,
      gender_probability FLOAT,
      sample_size INTEGER,
      age INTEGER,
      age_group TEXT,
      country_id TEXT,
      country_probability FLOAT,
      created_at TEXT NOT NULL
    )
  `);
  console.log("DB ready");
}

function getAgeGroup(age) {
  if (age <= 12) return "child";
  if (age <= 19) return "teenager";
  if (age <= 59) return "adult";
  return "senior";
}

// POST /api/profiles
app.post("/api/profiles", async (req, res) => {
  const name = req.body ? req.body.name : undefined;

  if (name !== undefined && typeof name !== "string") {
    return res
      .status(422)
      .json({
        status: "error",
        message: "Invalid type: name must be a string",
      });
  }

  if (!name || name.trim() === "") {
    return res
      .status(400)
      .json({ status: "error", message: "Missing required field: name" });
  }

  const trimmedName = name.trim().toLowerCase();
  const db = getPool();

  try {
    const existing = await db.query("SELECT * FROM profiles WHERE name = $1", [
      trimmedName,
    ]);
    if (existing.rows.length > 0) {
      return res.status(200).json({
        status: "success",
        message: "Profile already exists",
        data: existing.rows[0],
      });
    }
  } catch (err) {
    console.error("DB check error:", err.message);
    return res
      .status(500)
      .json({ status: "error", message: "Database error: " + err.message });
  }

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

    if (!genderData.gender || genderData.count === 0) {
      return res
        .status(200)
        .json({
          status: "error",
          message: "No gender prediction available for the provided name",
        });
    }

    if (agifyData.age === null || agifyData.age === undefined) {
      return res
        .status(200)
        .json({
          status: "error",
          message: "No age prediction available for the provided name",
        });
    }

    if (!nationalizeData.country || nationalizeData.country.length === 0) {
      return res
        .status(200)
        .json({
          status: "error",
          message: "No nationality prediction available for the provided name",
        });
    }

    const gender = genderData.gender;
    const gender_probability = genderData.probability;
    const sample_size = genderData.count;
    const age = agifyData.age;
    const age_group = getAgeGroup(age);
    const topCountry = nationalizeData.country.reduce((a, b) =>
      a.probability > b.probability ? a : b,
    );
    const country_id = topCountry.country_id;
    const country_probability = topCountry.probability;
    const id = uuidv7();
    const created_at = new Date().toISOString();

    await db.query(
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
    console.error("POST error:", error.message);
    if (error.request)
      return res
        .status(502)
        .json({
          status: "error",
          message: "External API did not respond in time",
        });
    return res
      .status(500)
      .json({
        status: "error",
        message: "Internal server error: " + error.message,
      });
  }
});

// GET /api/profiles — with optional filters
app.get("/api/profiles", async (req, res) => {
  const db = getPool();
  try {
    const { gender, age_group, country_id } = req.query;
    let query = "SELECT * FROM profiles WHERE 1=1";
    const params = [];

    if (gender) {
      params.push(gender.toLowerCase());
      query += ` AND gender = $${params.length}`;
    }
    if (age_group) {
      params.push(age_group.toLowerCase());
      query += ` AND age_group = $${params.length}`;
    }
    if (country_id) {
      params.push(country_id.toUpperCase());
      query += ` AND country_id = $${params.length}`;
    }

    query += " ORDER BY created_at DESC";
    const result = await db.query(query, params);

    return res.status(200).json({
      status: "success",
      count: result.rows.length,
      data: result.rows,
    });
  } catch (err) {
    return res.status(500).json({ status: "error", message: "Database error" });
  }
});

// GET /api/profiles/:id
app.get("/api/profiles/:id", async (req, res) => {
  const db = getPool();
  try {
    const result = await db.query("SELECT * FROM profiles WHERE id = $1", [
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

// DELETE /api/profiles/:id
app.delete("/api/profiles/:id", async (req, res) => {
  const db = getPool();
  try {
    const result = await db.query(
      "DELETE FROM profiles WHERE id = $1 RETURNING *",
      [req.params.id],
    );
    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ status: "error", message: "Profile not found" });
    }
    return res
      .status(200)
      .json({ status: "success", message: "Profile deleted" });
  } catch (err) {
    return res.status(500).json({ status: "error", message: "Database error" });
  }
});

app.use((req, res) => {
  res.status(404).json({ status: "error", message: "Route not found" });
});

initDB()
  .then(() =>
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`)),
  )
  .catch((err) => {
    console.error("Failed to init DB:", err.message);
    process.exit(1);
  });
