const WebSocket = require('ws');

const TTS_WS_URL = 'wss://api.minimax.io/v1/t2a_v2';

const phrases = [
  { name: 'haha', text: 'haha有话跟你说', voice: 'female-tianmei' },
  { name: 'mirror', text: 'mirror发来消息', voice: 'danya_xuejie' },
  { name: 'qcc', text: 'qcc在等你', voice: 'female-shaonv' }
];

const API_KEY = process.env.MINIMAX_API_KEY;
if (!API_KEY) {
  console.error('MINIMAX_API_KEY not set');
  process.exit(1);
}

async function generateAudio(text, voice) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(TTS_WS_URL, {
      headers: { 'Authorization': `Bearer ${API_KEY}` }
    });
    let audioHex = '';
    let resolved = false;

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        event: 'task_start',
        voice_id: voice,
        model: 'speech-02-hd',
        parameters: { sample_rate: 32000, bitrate: 128000 }
      }));
      setTimeout(() => {
        ws.send(JSON.stringify({ event: 'task_continue', text }));
      }, 100);
    });

    ws.addEventListener('message', (evt) => {
      try {
        const data = JSON.parse(evt.data);
        if (data.audio) {
          audioHex += data.audio;
        }
        if (data.status === 'completed' || data.type === 'task_end') {
          ws.close();
          if (!resolved) { resolved = true; resolve(audioHex); }
        }
      } catch (e) {}
    });

    ws.addEventListener('error', (err) => {
      if (!resolved) { resolved = true; reject(err); }
    });

    setTimeout(() => {
      if (!resolved) { resolved = true; resolve(audioHex); }
    }, 15000);
  });
}

async function main() {
  const fs = require('fs');
  const dir = '/home/danny/Tools/cc-hub/audio';
  fs.mkdirSync(dir, { recursive: true });

  for (const p of phrases) {
    console.log(`Generating ${p.name}: "${p.text}"...`);
    try {
      const hex = await generateAudio(p.text, p.voice);
      fs.writeFileSync(`${dir}/${p.name}.txt`, hex);
      console.log(`  saved ${hex.length} hex chars`);
    } catch (e) {
      console.error(`  error: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  console.log('Done!');
}

main();
