// Load environment from .env as early as possible
try {
  require('dotenv').config();
} catch (e) {
  // dotenv is optional; if not installed, environment variables can still be provided by the OS
}

const readline = require('readline');
const db = require('./db');
require('./events/logger'); // Initialize event logger
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// helper to use readline with async/await
function question(prompt) {
	return new Promise(resolve => rl.question(prompt, ans => resolve(ans)));
}

async function menu() {
  console.log(`
===== NodeVault =====
1. Add Record
2. Search Records
3. Sort Records
4. List Records
5. Update Record
6. Delete Record
7. Export Data
8. View Vault Statistics
9. Exit
=====================
  `);

  const ans = (await question('Choose option: ')).trim();

  switch (ans) {
    case '1': {
      const name = await question('Enter name: ');
      const value = await question('Enter value: ');
      const rec = await db.addRecord({ name, value });
      console.log('✅ Record added successfully!');
      console.log(`  MongoID: ${rec.id}`);
      console.log(`  userID:  ${rec.userID}`);
      await menu();
      break;
    }

    case '2': { // Search Records
      const term = (await question('Enter search keyword: ')).trim();
      if (!term) {
        console.log('Please enter a search keyword.');
        await menu();
        break;
      }
      const records = await db.listRecords();
      const lower = term.toLowerCase();
      const matches = records.filter(r => {
        if (!r) return false;
        // numeric userID match
        if (/^\d+$/.test(term) && Number(r.userID) === Number(term)) return true;
        // Mongo id contains term
        if (String(r.id || '').toLowerCase().includes(lower)) return true;
        // name contains term (case-insensitive)
        if (String(r.name || '').toLowerCase().includes(lower)) return true;
        return false;
      });
      if (!matches || matches.length === 0) {
        console.log('No records found.');
      } else {
        console.log(`Found ${matches.length} matching record${matches.length>1?'s':''}:`);
        matches.forEach((rec, i) => {
          // show userID as ID, name and created date
          console.log(`${i+1}. ID: ${rec.userID} | Name: ${rec.name} | Created: ${rec.created || 'N/A'}`);
        });
      }
      await menu();
      break;
    }

    case '3': { // Sort Records
      const fieldChoice = (await question('Choose field to sort by (1) Name or (2) Creation Date: ')).trim();
      if (!['1','2'].includes(fieldChoice)) {
        console.log('❌ Invalid choice. Choose 1 for Name or 2 for Creation Date.');
        await menu();
        break;
      }
      const orderChoice = (await question('Choose order (1) Ascending or (2) Descending: ')).trim();
      if (!['1','2'].includes(orderChoice)) {
        console.log('❌ Invalid order. Choose 1 for Ascending or 2 for Descending.');
        await menu();
        break;
      }
      const records = await db.listRecords();
      if (!records || records.length === 0) {
        console.log('No records found.');
        await menu();
        break;
      }

      const field = fieldChoice === '1' ? 'name' : 'created';
      const ascending = orderChoice === '1';

      // create a shallow copy and sort in-memory (do not modify DB)
      const sorted = records.slice().sort((a, b) => {
        const va = (a[field] || '').toString();
        const vb = (b[field] || '').toString();
        if (field === 'name') {
          const cmp = va.toLowerCase().localeCompare(vb.toLowerCase());
          return ascending ? cmp : -cmp;
        } else { // creation date (YYYY-MM-DD), compare lexicographically if present
          // fallback to empty strings so missing dates sort consistently
          if (va === vb) return 0;
          if (va === '') return ascending ? -1 : 1;
          if (vb === '') return ascending ? 1 : -1;
          // compare ISO-like date strings
          const cmp = va.localeCompare(vb);
          return ascending ? cmp : -cmp;
        }
      });

      console.log('Sorted Records:');
      sorted.forEach((r, idx) => {
        console.log(`${idx+1}. ID: ${r.userID} | Name: ${r.name} | Created: ${r.created || 'N/A'}`);
      });

      await menu();
      break;
    }

    case '4': {
      const records = await db.listRecords();
      if (records.length === 0) console.log('No records found.');
      else records.forEach(r => console.log(`userID: ${r.userID} | ID: ${r.id} | Name: ${r.name} | Value: ${r.value}`));
      await menu();
      break;
    }

    case '5': {
      const idStr = await question('Enter record userID to update: ');
      const id = parseInt(idStr.trim(), 10);
      if (!Number.isInteger(id)) {
        console.log('❌ Invalid userID — please enter a numeric userID.');
        await menu();
        break;
      }
      // check existence first
      const records = await db.listRecords();
      const existing = records.find(r => r.userID === id);
      if (!existing) {
        console.log('❌ Record not found.');
        await menu();
        break;
      }
      // proceed to prompt for new values only if record exists
      const name = await question('New name: ');
      const value = await question('New value: ');
      const updated = await db.updateRecord(id, name, value);
      console.log(updated ? `✅ Record updated (userID: ${updated.userID})` : '❌ Record not found.');
      await menu();
      break;
    }

    case '6': {
      const idStr = await question('Enter record userID to delete: ');
      const id = parseInt(idStr.trim(), 10);
      if (!Number.isInteger(id)) {
        console.log('❌ Invalid userID — please enter a numeric userID.');
        await menu();
        break;
      }
      const deleted = await db.deleteRecord(id);
      console.log(deleted ? `🗑️ Record deleted (userID: ${deleted.userID})` : '❌ Record not found.');
      await menu();
      break;
    }

    case '7': { // Export Data
      try {
        const records = await db.listRecords();
        const exportPath = path.join(__dirname, 'export.txt');
        const now = new Date();
        const headerLines = [
          'NodeVault Export',
          `Export Date: ${now.toISOString()}`,
          `Total Records: ${records.length}`,
          `File: export.txt`,
          ''.padEnd(40, '-')
        ];
        const bodyLines = records.map((r, i) => {
          const created = r.created || 'N/A';
          return `${i+1}. ID: ${r.userID} | Name: ${r.name} | Value: ${r.value} | Created: ${created}`;
        });
        const content = headerLines.concat(bodyLines).join('\n') + '\n';
        await fs.promises.writeFile(exportPath, content, 'utf8');
        console.log('Data exported successfully to export.txt.');
      } catch (err) {
        console.error('Failed to export data:', err.message || err);
      }
      await menu();
      break;
    }

    case '8': { // View Vault Statistics
      const records = await db.listRecords();
      if (!records || records.length === 0) {
        console.log('Vault Statistics:');
        console.log('--------------------------');
        console.log('Total Records: 0');
        console.log('No records available to compute further statistics.');
        await menu();
        break;
      }

      // Total number of records
      const total = records.length;

      // Most recent modification: use updatedAt if present, otherwise createdAt
      const modTimestamps = records
        .map(r => r.updatedAt || r.createdAt)
        .filter(Boolean)
        .map(ts => new Date(ts).getTime());
      const lastModifiedTs = modTimestamps.length ? Math.max(...modTimestamps) : null;
      const lastModified = lastModifiedTs ? new Date(lastModifiedTs).toISOString().replace('T',' ').split('.')[0] : 'N/A';

      // Longest name and its length
      let longestName = '';
      records.forEach(r => {
        const name = String(r.name || '');
        if (name.length > longestName.length) longestName = name;
      });
      const longestLen = longestName.length;

      // Earliest and latest creation dates (based on createdAt)
      const createTimestamps = records
        .map(r => r.createdAt)
        .filter(Boolean)
        .map(ts => new Date(ts).getTime());
      let earliest = 'N/A', latest = 'N/A';
      if (createTimestamps.length) {
        const minTs = Math.min(...createTimestamps);
        const maxTs = Math.max(...createTimestamps);
        earliest = new Date(minTs).toISOString().slice(0,10);
        latest = new Date(maxTs).toISOString().slice(0,10);
      }

      // Print stats
      console.log('Vault Statistics:');
      console.log('--------------------------');
      console.log(`Total Records: ${total}`);
      console.log(`Last Modified: ${lastModified}`);
      console.log(`Longest Name: ${longestName || 'N/A'} (${longestLen} character${longestLen!==1?'s':''})`);
      console.log(`Earliest Record: ${earliest}`);
      console.log(`Latest Record: ${latest}`);

      await menu();
      break;
    }

    case '9':
      console.log('👋 Exiting NodeVault...');
      rl.close();
      try { await db.close(); } catch (e) {}
      break;

    default:
      console.log('Invalid option.');
      await menu();
  }
}

// Start: initialize DB then show menu
(async () => {
	try {
		await db.init();
		await menu();
	} catch (err) {
		console.error('Failed to initialize DB:', err.message || err);
		process.exit(1);
	}
})();
////////////////////////////////Adding the version/////////////////////