import { readArticle } from '../adapters/browser/article';

// Loaded into a page's isolated world only when the person grabs the whole
// page, beside content.js, which calls it. Pages cannot see this world.
(globalThis as { zombieHandReadArticle?: typeof readArticle }).zombieHandReadArticle = readArticle;
