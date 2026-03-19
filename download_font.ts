import fs from 'fs';
import path from 'path';

async function downloadFont() {
  const fontDir = path.join(process.cwd(), 'assets', 'fonts');
  if (!fs.existsSync(fontDir)) {
    fs.mkdirSync(fontDir, { recursive: true });
  }

  const fontPath = path.join(fontDir, 'Roboto-Regular.ttf');
  if (fs.existsSync(fontPath)) {
    console.log('Font already exists.');
    return;
  }

  console.log('Downloading Roboto-Regular.ttf...');
  const res = await fetch('https://github.com/googlefonts/roboto/raw/main/src/hinted/Roboto-Regular.ttf');
  const arrayBuffer = await res.arrayBuffer();
  fs.writeFileSync(fontPath, Buffer.from(arrayBuffer));
  console.log('Font downloaded successfully.');
}

downloadFont().catch(console.error);
