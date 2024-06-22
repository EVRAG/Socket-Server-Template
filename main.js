const useful_functions = require("./functions");

const http = require("http");
const express = require("express");
const app = express();
const pool = require("./dbConfig");

const cors = require("cors");
app.use(cors());
app.use(express.static("public"));

const port = process.env.PORT || 3000;
const server = http.createServer(app);

const WebSocket = require("ws");
const wss = new WebSocket.Server({ server });

server.listen(port, () => {
  console.log(`Server started on port ${port}`);
});

let bets = [];
let coefficient = 1.0;
let isCrashed = false;
let intervalId;
let timerId;
let phase = "bet_phase";
let roundNumber = 1;

const startBetPhase = () => {
  phase = "bet_phase";
  bets = [];
  let betTime = 10;

  timerId = setInterval(() => {
    betTime -= 1;
    broadcastMessage({ event: "bet_timer", time: betTime });
    if (betTime <= 0) {
      phase = "bet_timer";
      clearInterval(timerId);
      startCrashPhase();
    }
  }, 1000);
};

const processBets = async () => {
  for (const bet of bets) {
    if (bet.cashoutCoefficient > coefficient) {
      await handleLose(bet);
    } else {
      await handleWin(bet);
    }
  }
};

const handleBet = async (ws, message, username) => {
  const amount = message.amount;
  const cashoutCoefficient =
    message.cashoutCoefficient >= 1.01 ? message.cashoutCoefficient : 10000;
  const balanceRes = await pool.query(
    "SELECT balance FROM casino WHERE username = $1",
    [username]
  );
  const balance = balanceRes.rows[0].balance;

  if (balance >= amount) {
    await pool.query(
      "UPDATE casino SET balance = balance - $1 WHERE username = $2",
      [amount, username]
    );
    const bet = {
      username,
      amount,
      cashoutCoefficient,
      ws,
      isCashedOut: false,
    };
    bets.push(bet);
    ws.send(messageBuilder(true, "bet_placed"));

    // Отправка обновленного баланса
    const newBalanceRes = await pool.query(
      "SELECT balance FROM casino WHERE username = $1",
      [username]
    );
    const newBalance = parseFloat(newBalanceRes.rows[0].balance).toFixed(2);
    ws.send(JSON.stringify({ event: "update_balance", balance: newBalance }));

    // Отправка сообщения о ставке
    broadcastMessage({
      username,
      amount,
      event: "new_bet",
    });
  } else {
    ws.send(messageBuilder(false, "bet_rejected"));
    ws.send(
      JSON.stringify({ event: "error", message: "Insufficient balance" })
    );
  }
};

const handleLose = async (bet) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Нет необходимости обновлять баланс при проигрыше, так как ставка сгорает
    const betDetails = {
      result: "lose",
      coefficient: coefficient.toFixed(2),
      amount: bet.amount.toFixed(2),
      round: roundNumber,
      timestamp: new Date(),
    };
    await updateBetHistory(bet.username, betDetails, client);

    await client.query("COMMIT");
    bet.ws.send(JSON.stringify({ event: "lose", message: `You lost!` }));

    const balanceRes = await client.query(
      "SELECT balance FROM casino WHERE username = $1",
      [bet.username]
    );
    const balance = balanceRes.rows[0].balance;
    bet.ws.send(JSON.stringify({ event: "update_balance", balance }));
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
};

const handleWin = async (bet) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const payout = bet.amount * bet.cashoutCoefficient;
    const queryText =
      "UPDATE casino SET balance = balance + $1 WHERE username = $2 RETURNING balance";
    const res = await client.query(queryText, [payout, bet.username]);
    const balance = res.rows[0].balance;

    const betDetails = {
      result: "win",
      coefficient: bet.cashoutCoefficient.toFixed(2),
      amount: payout.toFixed(2),
      round: roundNumber,
      timestamp: new Date(),
    };
    await updateBetHistory(bet.username, betDetails, client);

    await client.query("COMMIT");
    console.log(balance);
    bet.ws.send(JSON.stringify({ event: "update_balance", balance }));

    bet.ws.send(
      JSON.stringify({
        event: "win",
        message: `You cashed out at ${bet.cashoutCoefficient.toFixed(
          2
        )} and won ${payout.toFixed(2)}`,
      })
    );
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
};

const handleCashout = async (ws, message, username) => {
  const betIndex = bets.findIndex((bet) => bet.username === username);
  if (betIndex !== -1 && phase === "coefficient") {
    const bet = bets[betIndex];
    if (!bet.isCashedOut) {
      bet.isCashedOut = true;
      const coeff_out = Number(message.coeff);
      const payout = bet.amount * coeff_out;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        await client.query(
          "UPDATE casino SET balance = balance + $1 WHERE username = $2",
          [payout, username]
        );
        const betDetails = {
          result: "win",
          coefficient: coeff_out.toFixed(2),
          amount: payout.toFixed(2),
          round: roundNumber,
          timestamp: new Date(),
        };
        await updateBetHistory(username, betDetails, client);

        await client.query("COMMIT");

        // Отправка обновленного баланса
        const balanceRes = await client.query(
          "SELECT balance FROM casino WHERE username = $1",
          [username]
        );
        const balance = parseFloat(balanceRes.rows[0].balance).toFixed(2);
        ws.send(JSON.stringify({ event: "update_balance", balance }));

        ws.send(
          JSON.stringify({
            event: "win",
            message: `You cashed out at ${coeff_out.toFixed(
              2
            )} and won ${payout.toFixed(2)}`,
          })
        );
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
      bets.splice(betIndex, 1);
    } else {
      ws.send(
        JSON.stringify({
          event: "cashout_failed",
          message: "You have already cashed out",
        })
      );
    }
  } else {
    ws.send(
      JSON.stringify({ event: "cashout_failed", message: "Cannot cashout now" })
    );
  }
};

const startCrashPhase = () => {
  phase = "crash";
  coefficient = 1.0;
  isCrashed = false;
  phaseStartTime = Date.now();

  intervalId = setInterval(() => {
    if (!isCrashed) {
      phase = "coefficient";
      coefficient += 0.01;
      broadcastMessage({
        event: "coefficient",
        message: coefficient.toFixed(2),
      });
      // console.log(bets);
      processImmediateWins(coefficient);

      if (Math.random() < 0.01) {
        triggerCrash();
      }
    }
  }, 100);
};

const triggerCrash = () => {
  isCrashed = true;
  clearInterval(intervalId);
  broadcastMessage({ event: "game_crash", message: coefficient.toFixed(2) });
  processBets();
  phase = "game_crash";
  roundNumber++;
  setTimeout(startBetPhase, 5000); // Start bet phase after 5 seconds
};

const processImmediateWins = async (coef) => {
  const remainingBets = [];
  for (const bet of bets) {
    if (coef.toFixed(2) == bet.cashoutCoefficient) {
      if (!bet.isCashedOut) {
        bet.isCashedOut = true;
        await handleWin(bet);
      }
    } else {
      remainingBets.push(bet);
    }
  }
  bets = remainingBets;
};

const updateBetHistory = async (username, betDetails, client) => {
  const queryText =
    "UPDATE casino SET history = array_append(history, $1) WHERE username = $2";
  await client.query(queryText, [JSON.stringify(betDetails), username]);
};

wss.on("connection", async function connection(ws) {
  ws.send(
    JSON.stringify({
      message: phase,
      event: "connect_message",
    })
  );

  ws.on("message", async function (message) {
    message = JSON.parse(message);
    console.log("Сообщение получено:", JSON.stringify(message));
    let username = message.username;
    switch (message.event) {
      case "message":
        broadcastMessage(message);
        break;
      case "force_crash":
        if (phase === "coefficient" && !isCrashed) {
          triggerCrash();
        }
        break;
      case "bet":
        if (phase === "bet_timer" || phase === "bet_phase") {
          await handleBet(ws, message, username);
        } else {
          ws.send(messageBuilder(false, "bet_rejected"));
        }
        break;
      case "cashout":
        await handleCashout(ws, message, username);
        break;
      case "connection":
        useful_functions.connectionFunction(ws, username, pool);
        const balanceRes = await pool.query(
          "SELECT balance FROM casino WHERE username = $1",
          [username]
        );
        const balance = balanceRes.rows[0].balance;
        ws.send(JSON.stringify({ event: "update_balance", balance }));
        break;
    }
  });

  ws.on("close", () => {
    console.log("Соединение закрыто");
  });

  ws.on("error", (error) => {
    console.log("Произошла ошибка:", error);
  });
});

const messageBuilder = (message, state) => {
  return JSON.stringify({
    message,
    event: state,
  });
};

function broadcastMessage(message) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.get("/api/bet-history/:username", async (req, res) => {
  const { username } = req.params;
  try {
    const result = await pool.query(
      "SELECT history FROM casino WHERE username = $1",
      [username]
    );
    if (result.rows.length > 0) {
      res.json({ history: result.rows[0].history });
    } else {
      res.status(404).json({ error: "User not found" });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

startBetPhase();
