const { WebSocketServer } = require('ws');

// Port and Host configuration
// For local dev: defaults to 127.0.0.1:8080
// For deployment: set HOST=0.0.0.0 PORT=8080 (or your preferred port)
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '127.0.0.1';

const wss = new WebSocketServer({ port: PORT, host: HOST });

// In-memory room manager
// roomId -> Array of WebSocket client objects
const rooms = new Map();

console.log(`WebSocket Signaling Server running on ws://${HOST}:${PORT}`);

wss.on('connection', (ws) => {
  let currentRoomId = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      const { action, room } = data;

      if (action === 'join') {
        if (!room || typeof room !== 'string') {
          ws.send(JSON.stringify({ action: 'error', message: 'Invalid room name' }));
          return;
        }

        const cleanRoom = room.trim().toUpperCase();
        if (cleanRoom.length === 0) {
          ws.send(JSON.stringify({ action: 'error', message: 'Room name cannot be empty' }));
          return;
        }

        // Leave current room if already in one
        leaveRoom(ws, currentRoomId);

        // Join new room
        currentRoomId = cleanRoom;
        if (!rooms.has(cleanRoom)) {
          rooms.set(cleanRoom, []);
        }

        const clientList = rooms.get(cleanRoom);

        if (clientList.length >= 2) {
          ws.send(JSON.stringify({ action: 'error', message: 'Room is full (max 2 users)' }));
          currentRoomId = null;
          return;
        }

        clientList.push(ws);
        console.log(`Client joined room: ${cleanRoom}. Total peers: ${clientList.length}`);

        // Notify both clients in the room of connection status
        clientList.forEach((client) => {
          client.send(JSON.stringify({
            action: 'state',
            status: 'connected',
            peersCount: clientList.length
          }));
        });
        return;
      }

      // If they are not in a room, they cannot send other actions
      if (!currentRoomId) {
        ws.send(JSON.stringify({ action: 'error', message: 'Not joined to any room' }));
        return;
      }

      // Relay all other actions to the other peer in the room
      const clientList = rooms.get(currentRoomId);
      if (clientList) {
        clientList.forEach((client) => {
          if (client !== ws && client.readyState === ws.OPEN) {
            client.send(message.toString()); // Relays the stringified JSON packet directly
          }
        });
      }

    } catch (err) {
      console.error('Error handling WebSocket message:', err.message);
      ws.send(JSON.stringify({ action: 'error', message: 'Failed to process message' }));
    }
  });

  ws.on('close', () => {
    if (currentRoomId) {
      console.log(`Client disconnected from room: ${currentRoomId}`);
      leaveRoom(ws, currentRoomId);
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket connection error:', err.message);
  });
});

// Helper to remove client from a room and clean up if empty
function leaveRoom(ws, roomId) {
  if (!roomId || !rooms.has(roomId)) return;

  let clientList = rooms.get(roomId);
  clientList = clientList.filter((client) => client !== ws);

  if (clientList.length === 0) {
    rooms.delete(roomId);
    console.log(`Room ${roomId} is now empty and has been removed.`);
  } else {
    rooms.set(roomId, clientList);
    // Notify the remaining client that their partner left
    clientList.forEach((client) => {
      client.send(JSON.stringify({
        action: 'state',
        status: 'peer_disconnected',
        peersCount: clientList.length
      }));
    });
  }
}
