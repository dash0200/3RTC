// Loaded with `node --import` before the unit tests (see "test" in client/package.json)
import { register } from 'node:module';

register('./resolve.mjs', import.meta.url);
