const connectionFunction = async (ws, username, pool) => {
  try {
    const client = await pool.connect();
    const result = await client.query(
      "SELECT * FROM casino WHERE username = $1",
      [username]
    );
    if (result.rows.length === 0) {
      // If user does not exist, add to database
      const newUser = await client.query(
        "INSERT INTO casino (username, balance) VALUES ($1, $2) RETURNING *",
        [username, 0] // Starting balance can be adjusted as needed
      );
      ws.send(
        JSON.stringify({
          event: "user_info",
          username: newUser.rows[0].username,
          balance: newUser.rows[0].balance,
          history: [], // Initially empty history
        })
      );
    } else {
      // User exists, send user info
      ws.send(
        JSON.stringify({
          event: "user_info",
          username: result.rows[0].username,
          balance: result.rows[0].balance,
          history: result.rows[0].history,
        })
      );
    }
    client.release();
  } catch (err) {
    console.error("Error executing query", err);
    ws.send(
      JSON.stringify({
        event: "error",
        message: "Database error",
      })
    );
  }
};

module.exports = { connectionFunction };
