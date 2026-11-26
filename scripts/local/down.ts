/**
 * npm run local:down: stops the local test stack. Its data stays for the next
 * npm run local:up. `npm run local:down -- --reset` also deletes the data, so
 * the next local:up starts from an empty database (then run local:seed).
 */
import { supabase } from './stack';

const reset = process.argv.includes('--reset');
supabase(reset ? ['stop', '--no-backup'] : ['stop'], { inherit: true });
console.log(reset ? 'Stopped, and the local data was deleted.' : 'Stopped. The data stays for the next npm run local:up.');
