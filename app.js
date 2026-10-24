
const socket = io({
  autoConnect: true,
  reconnection: true
});

const $ = id => document.getElementById(id);

const status = $("status");
const detail = $("detail");
const connection = $("connection");
const findBtn = $("findBtn");
const nextBtn = $("nextBtn");
const endBtn = $("endBtn");
const acceptPanel = $("acceptPanel");
const remotePlaceholder = $("remotePlaceholder");
const localVideo = $("localVideo");
const remoteVideo = $("remoteVideo");
const micBtn = $("micBtn");
const cameraBtn = $("cameraBtn");

let localStream = null;
let pc = null;
let peerId = null;
let pendingCandidates = [];
let searching = false;
let asking = false;
let inCall = false;
let accepted = false;
let callToken = 0;

const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" }
    // Add your TURN server here for better connectivity.
  ]
};

function setStatus(title, message = "") {
  status.textContent = title;
  detail.textContent = message;
}

function updateButtons() {
  findBtn.disabled = searching || asking || inCall;
  nextBtn.disabled = !searching && !asking && !inCall;
  endBtn.disabled = !searching && !asking && !inCall;
  micBtn.disabled = !localStream;
  cameraBtn.disabled = !localStream;
}

async function prepareMedia() {
  if (localStream) return;

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera needs HTTPS or localhost.");
  }

  localStream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "user",
      width: { ideal: 640 },
      height: { ideal: 480 }
    },
    audio: true
  });

  localVideo.srcObject = localStream;
  micBtn.textContent = "Mic: On";
  cameraBtn.textContent = "Camera: On";
  updateButtons();
}

function closePeer() {
  callToken++;

  if (pc) {
    pc.ontrack = null;
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.close();
    pc = null;
  }

  remoteVideo.srcObject = null;
  pendingCandidates = [];
  remotePlaceholder.classList.remove("hidden");
}

function resetMatch() {
  closePeer();
  peerId = null;
  accepted = false;
  asking = false;
  inCall = false;
  acceptPanel.classList.add("hidden");
  updateButtons();
}

function endCurrent(notify = true) {
  if (notify && (searching || asking || inCall)) {
    socket.emit("leave_match");
  }

  searching = false;
  resetMatch();
  setStatus("Call ended", "You can find another random user.");
  updateButtons();
}

async function findUser() {
  if (!socket.connected) {
    setStatus("Connecting...", "Please wait for the server.");
    return;
  }

  if (searching || asking || inCall) return;

  try {
    await prepareMedia();
  } catch (err) {
    setStatus("Camera permission needed", err.message);
    return;
  }

  searching = true;
  setStatus("Finding someone...", "Please wait for a random user.");
  socket.emit("find");
  updateButtons();
}

function makePeer() {
  closePeer();

  const token = callToken;
  pc = new RTCPeerConnection(rtcConfig);

  localStream.getTracks().forEach(track => {
    pc.addTrack(track, localStream);
  });

  pc.ontrack = event => {
    if (token !== callToken) return;

    if (event.streams && event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
    } else {
      if (!remoteVideo.srcObject) {
        remoteVideo.srcObject = new MediaStream();
      }

      remoteVideo.srcObject.addTrack(event.track);
    }

    remotePlaceholder.classList.add("hidden");
    remoteVideo.play().catch(() => {});
  };

  pc.onicecandidate = event => {
    if (event.candidate && peerId && accepted) {
      socket.emit("ice_candidate", {
        candidate: event.candidate
      });
    }
  };

  pc.onconnectionstatechange = () => {
    if (!pc || token !== callToken) return;

    if (pc.connectionState === "connected") {
      setStatus("Connected!", "You are now on a video call.");
    } else if (pc.connectionState === "failed") {
      setStatus(
        "Connection failed",
        "A TURN server may be needed on this network."
      );
    } else if (pc.connectionState === "disconnected") {
      setStatus("Connection interrupted", "Trying to reconnect...");
    }
  };
}

async function flushCandidates() {
  if (!pc || !pc.remoteDescription) return;

  const list = pendingCandidates;
  pendingCandidates = [];

  for (const candidate of list) {
    try {
      await pc.addIceCandidate(candidate);
    } catch (err) {
      console.warn("ICE candidate failed", err);
    }
  }
}

async function acceptCall() {
  if (!peerId || !asking) return;

  accepted = true;
  asking = false;
  acceptPanel.classList.add("hidden");
  setStatus("Waiting for the other user...", "Both users must accept.");
  socket.emit("accept_call");
  updateButtons();
}

socket.on("connect", () => {
  connection.textContent = "Online";
  setStatus("Ready to meet someone?", "Tap Find Random User to begin.");
});

socket.on("disconnect", () => {
  connection.textContent = "Offline";
  searching = false;
  resetMatch();
  setStatus("Server disconnected", "Check your internet connection.");
});

socket.on("searching", () => {
  searching = true;
  setStatus("Finding someone...", "You are in the random queue.");
  updateButtons();
});

socket.on("match_found", ({ peer }) => {
  searching = false;
  peerId = peer;
  asking = true;
  accepted = false;

  acceptPanel.classList.remove("hidden");
  setStatus("Random user found!", "Accept the call or decline.");
  updateButtons();
});

socket.on("accept_received", () => {
  setStatus("You accepted", "Waiting for the other user's decision.");
});

socket.on("call_ready", async ({ initiator }) => {
  if (!peerId || !accepted) return;

  inCall = true;
  asking = false;
  acceptPanel.classList.add("hidden");
  setStatus("Connecting video...", "Setting up a secure peer connection.");
  updateButtons();

  try {
    makePeer();

    if (initiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      socket.emit("webrtc_offer", {
        description: pc.localDescription
      });
    }
  } catch (err) {
    setStatus("Could not start call", err.message);
  }
});

socket.on("webrtc_offer", async ({ description }) => {
  if (!pc || !description) return;

  try {
    await pc.setRemoteDescription(description);
    await flushCandidates();

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit("webrtc_answer", {
      description: pc.localDescription
    });
  } catch (err) {
    setStatus("Call setup failed", err.message);
  }
});

socket.on("webrtc_answer", async ({ description }) => {
  if (!pc || !description) return;

  try {
    await pc.setRemoteDescription(description);
    await flushCandidates();
  } catch (err) {
    console.warn("Answer failed", err);
  }
});

socket.on("ice_candidate", async ({ candidate }) => {
  if (!candidate) return;

  if (!pc || !pc.remoteDescription) {
    pendingCandidates.push(candidate);
    return;
  }

  try {
    await pc.addIceCandidate(candidate);
  } catch (err) {
    console.warn("ICE failed", err);
  }
});

socket.on("partner_left", ({ reason }) => {
  searching = false;
  resetMatch();

  const message = reason === "rejected"
    ? "The other user declined the call."
    : "The other user has left.";

  setStatus("Call ended", message);
});

socket.on("match_cancelled", () => {
  searching = false;
  resetMatch();
  setStatus("Match ended", "You can search again.");
});

findBtn.addEventListener("click", findUser);

$("acceptBtn").addEventListener("click", acceptCall);

rejectBtn.addEventListener("click", () => {
  if (peerId) socket.emit("reject_call");

  searching = false;
  resetMatch();
  setStatus("Call declined", "You can find another user.");
});

endBtn.addEventListener("click", () => endCurrent(true));

nextBtn.addEventListener("click", async () => {
  endCurrent(true);
  await findUser();
});

micBtn.addEventListener("click", () => {
  if (!localStream) return;

  const track = localStream.getAudioTracks()[0];
  if (!track) return;

  track.enabled = !track.enabled;
  micBtn.textContent = track.enabled ? "Mic: On" : "Mic: Off";
});

cameraBtn.addEventListener("click", () => {
  if (!localStream) return;

  const track = localStream.getVideoTracks()[0];
  if (!track) return;

  track.enabled = !track.enabled;
  cameraBtn.textContent =
    track.enabled ? "Camera: On" : "Camera: Off";
});

window.addEventListener("beforeunload", () => {
  socket.emit("leave_match");
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
  }
});

updateButtons();
