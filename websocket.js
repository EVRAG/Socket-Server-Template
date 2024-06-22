const ws = require("ws");

const wss = new ws.Server(
  {
    port: 6666,
  },
  () => console.log(`Server started on 5000`)
);

wss.on("connection", function connection(ws) {
  console.log("Новое соединение установлено");

  ws.on("message", function (message) {
    console.log("Сообщение получено:", message);
    message = JSON.parse(message);
    switch (message.event) {
      case "message":
        broadcastMessage(message);
        break;
      case "connection":
        broadcastMessage(message);
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

function broadcastMessage(message) {
  wss.clients.forEach((client) => {
    if (client.readyState === ws.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}
