// Simple JSON file database — no compilation required
const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data.json');

function load() {
  if (!fs.existsSync(FILE)) return { transcripts: [], nextId: 1 };
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (_) { return { transcripts: [], nextId: 1 }; }
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

const db = {
  // Return all transcripts, newest first
  all() {
    return load().transcripts.slice().reverse();
  },

  // Insert a new transcript, return the new row
  insert({ url, platform, title, transcript }) {
    const data = load();
    const row = {
      id: data.nextId++,
      url, platform, title, transcript,
      created_at: new Date().toISOString(),
    };
    data.transcripts.push(row);
    save(data);
    return row;
  },

  // Delete by id
  delete(id) {
    const data = load();
    data.transcripts = data.transcripts.filter(t => t.id !== Number(id));
    save(data);
  },
};

module.exports = db;
