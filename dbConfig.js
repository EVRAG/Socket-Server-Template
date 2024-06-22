const { Pool } = require("pg");

const pool = new Pool({
  user: "postgres",
  password: "qestr@@A1@@",
  host: "5.35.89.21",
  database: "postgres",
  port: 5432,
});

module.exports = pool;
