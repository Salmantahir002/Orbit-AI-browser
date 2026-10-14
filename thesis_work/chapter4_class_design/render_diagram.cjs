const path = require('node:path');
const sharp = require('C:/Users/salman/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const root = path.resolve(__dirname, '../..');
(async () => {
  await sharp(path.join(root, 'Orbit_Class_Design.svg'), {density:180})
    .png().withMetadata({density:300}).toFile(path.join(root,'Orbit_Class_Design.png'));
  await sharp(path.join(root, 'Orbit_Class_Design.svg')).resize({width:1800}).png()
    .toFile(path.join(__dirname, 'qa', 'diagram-preview.png'));
  console.log('Rendered PNG and diagram preview');
})().catch(err => { console.error(err); process.exit(1); });
