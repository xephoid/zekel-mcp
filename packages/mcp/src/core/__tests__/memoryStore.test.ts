import { MemorySessionStore } from '../store/memory.js';
import { runSessionStoreContract } from './sessionStoreContract.js';

runSessionStoreContract('MemorySessionStore', () => new MemorySessionStore());
