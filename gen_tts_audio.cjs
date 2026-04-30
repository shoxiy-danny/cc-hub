const WebSocket = require('ws');
const fs = require('fs');

const TTS_WS_URL = 'wss://api.minimaxi.com/ws/v1/t2a_v2';
const TTS_MODEL = 'speech-2.8-hd';

const phrases = [
  { name: 'haha', text: 'haha有话跟你说', voice: 'female-tianmei' },
  { name: 'mirror', text: 'mirror发来消息', voice: 'danya_xuejie' },
  { name: 'qcc', text: 'qcc在等你', voice: 'female-shaonv' }
];

async function generateAudio(text, voice) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(TTS_WS_URL, {
      headers: { 'Authorization': `Bearer ${API_KEY}` }
    });
    let audioHex = '';
    let resolved = false;
    let connected = false;

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        event: 'task_start',
        model: TTS_MODEL,
        voice_setting: {
          voice_id: voice,
          speed: 1,
          vol: 1,
          pitch: 0,
          english_normalization: false
        },
        audio_setting: {
          sample_rate: 32000,
          bitrate: 128000,
          format: 'mp3',
          channel: 1
        }
      }));
    });

    ws.addEventListener('message', (evt) => {
      try {
        const data = JSON.parse(evt.data);
        if (!connected && data.event === 'connected_success') {
          connected = true;
          ws.send(JSON.stringify({ event: 'task_continue', text }));
          return;
        }
        if (data.data?.audio) {
          audioHex += data.data.audio;
        }
        if (data.is_final) {
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
  const dir = '/home/danny/Tools/cc-hub/audio';
  fs.mkdirSync(dir, { recursive: true });

  for (const p of phrases) {
    console.log(`Generating ${p.name}: "${p.text}" (${p.voice})...`);
    try {
      const hex = await generateAudio(p.text, p.voice);
      fs.writeFileSync(`${dir}/${p.name}.txt`, hex);
      console.log(`  saved ${hex.length} hex chars (${Math.floor(hex.length/2)} bytes)`);
    } catch (e) {
      console.error(`  error: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log('Done!');
}

const API_KEY = process.env.MINIMAX_API_KEY;
if (!API_KEY) {
  console.error('MINIMAX_API_KEY not set'); process.exit(1);
}
main();
