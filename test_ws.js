const ws = new WebSocket('wss://api.minimaxi.com/ws/v1/t2a_v2', {
  headers: {
    'Authorization': 'Bearer sk-cp-W4w0H1NSPj9Na9oQeS0UK2ntyCkIjqQjAiJ8F_64w8TAYeS5QmOrZoTlRyDmbtvtN7rgSWj8wR8FKFrNq5N5RsqrrqH26c5iYWkv69x8glaYr9N0TAW3i58'
  }
});

ws.onOpen = () => {
  console.log('WS connected!');
  ws.send(JSON.stringify({
    event: 'task_start',
    model: 'speech-2.8-hd',
    voice_setting: { voice_id: 'female-tianmei', speed: 1, vol: 1, pitch: 0, english_normalization: false },
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 }
  }));
};

ws.onMessage = (evt) => {
  console.log('Received:', evt.data.substring(0, 100));
};

ws.onError = (err) => {
  console.log('WS error:', err);
};

ws.onClose = () => {
  console.log('WS closed');
};

setTimeout(() => {
  if (ws.readyState === WebSocket.CONNECTING) {
    console.log('Connection timeout');
    ws.close();
  }
}, 10000);
