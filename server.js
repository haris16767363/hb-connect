
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
  maxHttpBufferSize: 1e6
});

app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public")));

const waiting = [];
const paired = new Map();
const accepted = new Map();
const busy = new Set();

function removeFromQueue(id) {
  const i = waiting.indexOf(id);
  if (i !== -1) waiting.splice(i, 1);
}

function clearPair(id, reason = "ended") {
  const other = paired.get(id);
  if (!other) return;

  paired.delete(id);
  paired.delete(other);
  accepted.delete(id);
  accepted.delete(other);
  busy.delete(id);
  busy.delete(other);

  io.to(other).emit("partner_left", { reason });
  io.to(id).emit("match_cancelled", { reason });
}

function findMatch(socket) {
  const id = socket.id;

  removeFromQueue(id);

  if (paired.has(id) || busy.has(id)) return;

  let other = null;

  while (waiting.length) {
    const candidate = waiting.shift();
    const s = io.sockets.sockets.get(candidate);

    if (
      s &&
      s.connected &&
      candidate !== id &&
      !paired.has(candidate) &&
      !busy.has(candidate)
    ) {
      other = candidate;
      break;
    }
  }

  if (!other) {
    waiting.push(id);
    socket.emit("searching");
    return;
  }

  paired.set(id, other);
  paired.set(other, id);
  accepted.set(id, false);
  accepted.set(other, false);
  busy.add(id);
  busy.add(other);

  const room = io.sockets.sockets.get(other);

  socket.emit("match_found", { peer: other });
  if (room) room.emit("match_found", { peer: id });
}

io.on("connection", socket => {
  socket.emit("connected");

  socket.on("find", () => {
    if (paired.has(socket.id) || busy.has(socket.id)) return;
    findMatch(socket);
  });

  socket.on("accept_call", () => {
    const id = socket.id;
    const other = paired.get(id);

    if (!other || !io.sockets.sockets.has(other)) return;

    accepted.set(id, true);
    socket.emit("accept_received");

    if (accepted.get(other) === true) {
      const a = id;
      const b = other;

      io.to(a).emit("call_ready", {
        initiator: a < b
      });

      io.to(b).emit("call_ready", {
        initiator: b < a
      });
    }
  });

  socket.on("reject_call", () => {
    const other = paired.get(socket.id);
    if (!other) return;

    clearPair(socket.id, "rejected");
  });

  socket.on("leave_match", () => {
    removeFromQueue(socket.id);
    clearPair(socket.id);
  });

  // Only the two matched users may exchange WebRTC signals.
  for (const event of ["webrtc_offer", "webrtc_answer", "ice_candidate"]) {
    socket.on(event, data => {
      const other = paired.get(socket.id);

      if (!other || !accepted.get(socket.id) ||
          !accepted.get(other)) return;

      if (!data || typeof data !== "object") return;

      io.to(other).emit(event, data);
    });
  }

  socket.on("disconnect", () => {
    removeFromQueue(socket.id);
    clearPair(socket.id, "disconnected");
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "HB Connect" });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HB Connect listening on port ${PORT}`);
});
