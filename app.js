'use strict';

/* Date Night Decider — Version 3.1.2 Product Engine
   - Native Capacitor Bridge Integration
   - RevenueCat In-App Purchase Architecture
   - Hardened WebRTC TURN Relay Infrastructure */

const Purchases = (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Purchases) || (typeof window !== 'undefined' && window.Purchases) || null;

const getEl = id => document.getElementById(id);

let db = null;
let useMemoryFallback = typeof window.Dexie !== 'function';

if (useMemoryFallback) {
  console.warn('Dexie did not load. Running with temporary in-memory storage.');
} else {
  try {
    db = new Dexie('DateNightDatabase');
    db.version(1).stores({
      settings: 'key',
      customDeck: '++id, id',
      deletedBuiltins: 'id',
      categories: 'id',
      history: '++id, date',
      unlocks: 'id'
    });
  } catch (err) {
    console.warn('IndexedDB is unavailable; using temporary in-memory state:', err);
    useMemoryFallback = true;
  }
}

const DEFAULT_CATEGORIES = [
  'baking', 'cooking', 'gaming', 'board games', 'tv', 'movie',
  'micro-adventure', 'quest', 'arcade'
];

function limitText(value, maxLength = 1000) {
  if (typeof value !== 'string') return '';
  return value.replace(/\u0000/g, '').trim().slice(0, maxLength);
}

function sanitizeCard(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const id = limitText(raw.id, 80);
  const title = limitText(raw.title, 160);
  const category = limitText(raw.category, 40);
  const budget = raw.budget;
  const location = raw.location;

  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) return null;
  if (!title) return null;
  if (!DEFAULT_CATEGORIES.includes(category)) return null;
  if (!['free', 'paid'].includes(budget)) return null;
  if (!['home', 'out'].includes(location)) return null;

  const candidateGradient = limitText(raw.gradient, 100);
  const safeGradient = /^linear-gradient\(135deg,\s*#[0-9a-f]{6},\s*#[0-9a-f]{6}\)$/i.test(candidateGradient)
    ? candidateGradient
    : 'linear-gradient(135deg, #31103f, #190a24)';

  const card = {
    id,
    title,
    detail: limitText(raw.detail, 3000),
    category,
    budget,
    location,
    costEstimate: limitText(raw.costEstimate, 120),
    gradient: safeGradient
  };

  if (raw.duration !== undefined) card.duration = limitText(raw.duration, 100);

  if (Array.isArray(raw.equipment)) {
    card.equipment = raw.equipment.slice(0, 20).map(item => limitText(item, 200)).filter(Boolean);
  } else if (typeof raw.equipment === 'string') {
    card.equipment = limitText(raw.equipment, 200);
  }

  if (raw.mission !== undefined) card.mission = limitText(raw.mission, 3000);
  if (raw.atHomeAlternative !== undefined) card.atHomeAlternative = limitText(raw.atHomeAlternative, 1500);
  if (raw.importantRule !== undefined) card.importantRule = limitText(raw.importantRule, 1500);

  if (Array.isArray(raw.howToPlay)) {
    card.howToPlay = raw.howToPlay.slice(0, 20).map(step => limitText(step, 400)).filter(Boolean);
  }

  if (typeof raw.banned === 'boolean') card.banned = raw.banned;
  return card;
}

function sanitizeCardDeck(rawDeck, maxCards = 500) {
  if (!Array.isArray(rawDeck)) return [];
  const output = [];
  const seenIds = new Set();

  rawDeck.slice(0, maxCards).forEach(rawCard => {
    const card = sanitizeCard(rawCard);
    if (!card || seenIds.has(card.id)) return;
    seenIds.add(card.id);
    output.push(card);
  });

  return output;
}

function sanitizeHistoryEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const dateText = limitText(raw.date, 80);
  const time = Date.parse(dateText);
  if (!Number.isFinite(time)) return null;

  const safeRating = value => {
    const number = Number(value);
    return Number.isInteger(number) && number >= 1 && number <= 5 ? number : null;
  };

  const syncId = limitText(raw.syncId, 120) || createUniqueId();
  const category = DEFAULT_CATEGORIES.includes(raw.category) ? raw.category : 'Date';

  return {
    syncId,
    cardId: limitText(raw.cardId, 80) || null,
    title: limitText(raw.title, 160) || 'Untitled date',
    category,
    detail: limitText(raw.detail, 3000),
    date: new Date(time).toISOString(),
    rating1: safeRating(raw.rating1),
    rating2: safeRating(raw.rating2),
    note: limitText(raw.note, 2000)
  };
}

let customDeck = [];
let deletedBuiltins = new Set();
let unlockedItems = [];
let dateHistory = [];
let appSettings = { theme: 'dark', feedback: 'both' };
let fullDeck = [];
let activeDeck = [];
let selectedPreviewItemId = null;
let selectedCategories = [...DEFAULT_CATEGORIES];
let selectedPacks = ['starter'];

/* Production Unified Entitlement Identifiers */
const ENTITLEMENT_IDS = {
  ALL_EXPANSIONS: 'unlocked_expansion_packs',
  PACK_ADVENTURE: 'expansion_adventure_pack',
  PACK_COZY: 'expansion_cozy_pack',
  PACK_GOURMET: 'expansion_gourmet_pack',
  PACK_NIGHTOUT: 'expansion_nightout_pack',
  PACK_BUDGET: 'expansion_budget_pack'
};

/* Secure Ephemeral ICE Server Configuration Function for PeerJS */
async function fetchEphemeralIceServers() {
  try {
    const response = await fetch('/api/get-ice-servers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ expiresInSeconds: 300 })
    });

    if (!response.ok) {
      throw new Error(`ICE fetch failed with status ${response.status}`);
    }

    const data = await response.json();
    return data.iceServers;
  } catch (error) {
    console.warn('Fallback to secure public STUN due to TURN token fetch failure:', error);
    return [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ];
  }
}

let PEER_OPTIONS = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ],
    iceCandidatePoolSize: 10
  }
};

function showToast(message, duration = 3500) {
  let container = getEl('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:200;display:grid;gap:8px;pointer-events:none;width:90%;max-width:400px;';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.style.cssText = 'background:#241436;border:1px solid var(--gold);color:var(--cream);padding:12px 16px;border-radius:12px;font-size:0.82rem;font-weight:700;box-shadow:0 8px 24px rgba(0,0,0,0.85);pointer-events:auto;text-align:center;animation:fadeInOut 0.3s ease;';
  toast.textContent = message;
  container.appendChild(toast);
  window.setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    window.setTimeout(() => toast.remove(), 300);
  }, duration);
}

async function triggerHaptic(type = 'light') {
  if (!['both', 'vibration'].includes(appSettings.feedback)) return;
  if (window.Capacitor && window.Capacitor.isPluginAvailable('Haptics')) {
    try {
      const { Haptics, ImpactStyle, NotificationType } = window.Capacitor.Plugins;
      if (type === 'light') await Haptics.impact({ style: ImpactStyle.Light });
      else if (type === 'heavy') await Haptics.impact({ style: ImpactStyle.Heavy });
      else if (type === 'success') await Haptics.notification({ type: NotificationType.Success });
      return;
    } catch (_) {}
  }
  if (!('vibrate' in navigator)) return;
  try {
    if (type === 'light') navigator.vibrate(15);
    else if (type === 'success') navigator.vibrate([40, 60, 40]);
    else if (type === 'heavy') navigator.vibrate(50);
  } catch (_) {}
}

const audioCtx = (() => {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    return AudioContextClass ? new AudioContextClass() : null;
  } catch (_) { return null; }
})();

function playSound(type) {
  if (!['both', 'sound'].includes(appSettings.feedback) || !audioCtx) return;
  try {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    const now = audioCtx.currentTime;
    if (type === 'swipe') {
      osc.frequency.setValueAtTime(350, now);
      osc.frequency.exponentialRampToValueAtTime(120, now + 0.08);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.linearRampToValueAtTime(0.01, now + 0.08);
      osc.start(now); osc.stop(now + 0.08);
    } else if (type === 'ban') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(160, now);
      osc.frequency.exponentialRampToValueAtTime(70, now + 0.1);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.linearRampToValueAtTime(0.01, now + 0.1);
      osc.start(now); osc.stop(now + 0.1);
    } else if (type === 'win') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(523, now);
      osc.frequency.setValueAtTime(659, now + 0.1);
      osc.frequency.setValueAtTime(783, now + 0.2);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.linearRampToValueAtTime(0.01, now + 0.35);
      osc.start(now); osc.stop(now + 0.35);
    }
  } catch (err) { console.debug('Sound unavailable:', err); }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}

const masterDeck = [
  { id:'baking-01', title:'Apple-Blackberry Lattice Pie', detail:'Make an all-butter pie dough from scratch, roll out a woven lattice top, and fill with fresh apple and blackberry.', category:'baking', budget:'paid', location:'home', costEstimate:'$10–$15 for ingredients', gradient:'linear-gradient(135deg, #4a1525, #831843)' },
  { id:'baking-02', title:'Cream Cheese Danish Batch', detail:'Make laminated pastry dough from scratch, fill with sweet cream cheese and fruit preserves, and bake until golden.', category:'baking', budget:'paid', location:'home', costEstimate:'$8–$12 for ingredients', gradient:'linear-gradient(135deg, #3b1f2b, #701a75)' },
  { id:'cooking-01', title:'Homemade Gourmet Pizza Night', detail:'Stretch homemade dough from scratch, layer with custom sauces, premium cheese, and your favorite toppings.', category:'cooking', budget:'paid', location:'home', costEstimate:'$12–$20 for toppings', gradient:'linear-gradient(135deg, #1e293b, #0f172a)' },
  { id:'cooking-02', title:'Authentic Street Taco Bar', detail:'Prep slow-cooked carnitas or grilled chicken with homemade salsas, fresh cilantro, and warm corn tortillas.', category:'cooking', budget:'paid', location:'home', costEstimate:'$15–$25 for fresh ingredients', gradient:'linear-gradient(135deg, #451a03, #78350f)' },
  { id:'gaming-01', title:'Cozy Split-Screen Co-Op', detail:'Load up a relaxing couch co-op video game and work together to build a shared virtual world or solve puzzles.', category:'gaming', budget:'free', location:'home', costEstimate:'Free (using owned games)', gradient:'linear-gradient(135deg, #064e3b, #022c22)' },
  { id:'gaming-02', title:'Arcade High Score Showdown', detail:'Play classic arcade games or fast-paced party games and battle head-to-head for the top spot.', category:'gaming', budget:'paid', location:'out', costEstimate:'$10–$25 arcade tokens', gradient:'linear-gradient(135deg, #172554, #1e3a8a)' },
  { id:'board-01', title:'Intense Strategy Board Game', detail:'Brew some coffee or tea, clear the table, and dive into a deep tabletop strategy or card drafting game.', category:'board games', budget:'free', location:'home', costEstimate:'Free (using owned games)', gradient:'linear-gradient(135deg, #312e81, #1e1b4b)' },
  { id:'board-02', title:'Fast-Paced Party Card Game', detail:'Pull out a hilarious casual card game for quick laughs and lighthearted competition.', category:'board games', budget:'free', location:'home', costEstimate:'Free (using owned games)', gradient:'linear-gradient(135deg, #581c87, #3b0764)' },
  { id:'tv-01', title:'Nostalgic TV Show Pilot Night', detail:'Rewatch the pilot episodes of your favorite childhood TV series together.', category:'tv', budget:'free', location:'home', costEstimate:'Free on streaming', gradient:'linear-gradient(135deg, #831843, #500724)' },
  { id:'tv-02', title:'Binge-Worthy Mystery Series', detail:'Stream the opening episodes of a gripping new thriller or mystery show.', category:'tv', budget:'free', location:'home', costEstimate:'Free on streaming', gradient:'linear-gradient(135deg, #0f766e, #115e59)' },
  { id:'movie-01', title:'First-Time Epic Adventure', detail:'Stream a critically acclaimed adventure or sci-fi movie that neither of you has ever seen.', category:'movie', budget:'free', location:'home', costEstimate:'Free on streaming', gradient:'linear-gradient(135deg, #31103f, #190a24)' },
  { id:'movie-02', title:'Local Cinema Night Out', detail:'Get dressed up, grab buttery popcorn at the local movie theater, and catch the latest release.', category:'movie', budget:'paid', location:'out', costEstimate:'$20–$40 tickets & snacks', gradient:'linear-gradient(135deg, #6b21a8, #4c1d95)' },
  { id:'micro-01', title:'Photo Scavenger Walk', detail:'Take a short walk and capture photos of five surprising textures, colors, patterns, or tiny details.', category:'micro-adventure', budget:'free', location:'out', costEstimate:'Free', duration:'30–45 minutes', equipment:['Phone camera'], mission:'Find five photos that tell a tiny story about your neighborhood.', howToPlay:['Pick five prompts such as something tiny, something bright, a pattern, a funny sign, and a peaceful spot.','Walk together in a familiar public area and take one photo for each prompt.','Trade phones and choose each other’s favorite photo.'], gradient:'linear-gradient(135deg, #0f766e, #164e63)' },
  { id:'micro-02', title:'Five-Senses Cozy Challenge', detail:'Build a cozy at-home mini-adventure around textures, sounds, scents, tastes, and things you can see.', category:'micro-adventure', budget:'free', location:'home', costEstimate:'Free with household items', duration:'20–30 minutes', equipment:['A few household items'], mission:'Create one small moment for each of the five senses.', howToPlay:['Each person picks two safe household items or experiences.','Take turns guessing an item by sound, texture, scent, or taste only when safe and appropriate.','Finish by choosing the sense that made you laugh most.'], gradient:'linear-gradient(135deg, #0f766e, #134e4a)' },
  { id:'quest-01', title:'Neighborhood Clue Quest', detail:'Create a short, friendly route with clues that lead to a shared destination such as a park, public mural, or favorite snack stop.', category:'quest', budget:'free', location:'out', costEstimate:'Free; optional snack cost', duration:'30–60 minutes', equipment:['Phone notes or paper'], mission:'Solve three clues together before reaching the final stop.', howToPlay:['Choose a familiar, safe route and a public destination.','Write three simple clues based on visible landmarks, not private property.','Take turns reading clues and solving them together.'], importantRule:'Stay in public, accessible areas and follow local rules.', gradient:'linear-gradient(135deg, #1d4ed8, #312e81)' },
  { id:'quest-02', title:'At-Home Treasure Trail', detail:'Hide three small notes or household objects and create clues that lead your partner from one to the next.', category:'quest', budget:'free', location:'home', costEstimate:'Free with household items', duration:'15–30 minutes', equipment:['Paper and pen'], mission:'Make a tiny treasure hunt with a sweet or funny final message.', howToPlay:['One person hides three notes in easy-to-find places.','Write a clue for each location and make the last clue lead to a final message or shared treat.','Switch roles and run the hunt again.'], gradient:'linear-gradient(135deg, #1d4ed8, #172554)' },
  { id:'arcade-01', title:'Best-of-Three Skill Showdown', detail:'Pick three quick, safe household challenges and compete for two wins—or combine scores as a team.', category:'arcade', budget:'free', location:'home', costEstimate:'Free with household items', duration:'15–25 minutes', equipment:['Paper cups or soft household items'], mission:'Play three quick rounds and crown the champion.', howToPlay:['Choose three safe challenges such as paper-ball toss into a bin, cup stacking, or drawing with your non-dominant hand.','Agree on a simple scoring rule before each round.','Winner chooses the next song or snack; then swap roles.'], importantRule:'Use soft objects and clear a safe space before playing.', gradient:'linear-gradient(135deg, #7e22ce, #4c1d95)' },
  { id:'arcade-02', title:'Blind Drawing Guess-Off', detail:'Take turns describing a simple object while the other person draws it without seeing a reference picture.', category:'arcade', budget:'free', location:'home', costEstimate:'Free with paper and pens', duration:'15–20 minutes', equipment:['Paper','Pens or pencils'], mission:'Earn points for accurate guesses and funniest drawings.', howToPlay:['One player privately chooses a simple object and describes its shape in short steps.','The other draws based only on the description.','Reveal the object, award one point for a correct guess and one bonus point for the funniest result, then switch.'], gradient:'linear-gradient(135deg, #7e22ce, #701a75)' }
];

const storeCatalog = [
  { id: 'pack-viral', title: 'Pack 1: Viral Micro-Adventures', type: 'deck', price: '$0.99', desc: 'Seven unusual little adventures that turn ordinary places, objects, and memories into a date.', gradient: 'linear-gradient(135deg, #31103f, #190a24)' },
  { id: 'pack-coop', title: 'Pack 2: Co-Op Worlds & Gaming Challenges', type: 'deck', price: '$0.99', desc: 'Seven cooperative challenges for couples who enjoy digital, tabletop, or creative building games.', gradient: 'linear-gradient(135deg, #064e3b, #022c22)' },
  { id: 'pack-sweet', title: 'Pack 3: Sweet Treat Showdown', type: 'deck', price: '$0.99', desc: 'Seven relaxed dessert challenges, from a complete cookie recipe to quick no-bake creations.', gradient: 'linear-gradient(135deg, #4a1525, #831843)' },
  { id: 'pack-quest', title: 'Pack 4: Around-Town Adventure Quest', type: 'deck', price: '$0.99', desc: 'Seven structured mini-outings with exact missions and free at-home alternatives.', gradient: 'linear-gradient(135deg, #1e293b, #0f172a)' },
  { id: 'pack-arcade', title: 'Pack 5: The Couples Challenge Arcade', type: 'deck', price: '$0.99', desc: 'Seven quick head-to-head or cooperative challenges with simple scoring and zero special equipment.', gradient: 'linear-gradient(135deg, #581c87, #3b0764)' }
];

const expansionDecks = {
  'pack-viral': [
    { id:'viral-01', title:'Three-Stop Photo Safari', detail:'Find three interesting public places nearby and take a photo at each stop.', category:'micro-adventure', budget:'free', location:'out', costEstimate:'Free', duration:'30–45 minutes', equipment:['Phone camera'], mission:'Capture a tiny photo story in three stops.', howToPlay:['Choose a safe, walkable public route with three stops.','At each stop, take one photo that fits a prompt chosen by your partner.','Share the three photos and name your mini photo story.'], atHomeAlternative:'Take a photo safari around your home or yard.', gradient:'linear-gradient(135deg, #0f766e, #164e63)' },
    { id:'viral-02', title:'One-Color Date', detail:'Choose a color and spend the date noticing or creating things that match it.', category:'micro-adventure', budget:'free', location:'home', costEstimate:'Free with what you have', duration:'20–40 minutes', equipment:['Optional phone camera'], mission:'Collect five things that match your chosen color.', howToPlay:['Each player secretly chooses a color; agree on one by a coin toss or quick vote.','Find five safe things that match it, indoors or on a walk.','Pick the most unexpected match and explain why you chose it.'], gradient:'linear-gradient(135deg, #0f766e, #134e4a)' },
    { id:'viral-03', title:'Memory Lane Soundtrack', detail:'Build a mini soundtrack from songs that remind you of different moments in your relationship.', category:'micro-adventure', budget:'free', location:'home', costEstimate:'Free if you have music access', duration:'30 minutes', equipment:['Music app or owned tracks'], mission:'Choose one song for a memory, one for today, and one for your future.', howToPlay:['Take turns naming a memory or moment.','Choose a song that fits it and explain the connection.','Finish by picking a song for an adventure you want to share.'], gradient:'linear-gradient(135deg, #0f766e, #115e59)' },
    { id:'viral-04', title:'Mystery Snack Tasting', detail:'Choose a few familiar snacks and rate them without seeing each other’s rankings.', category:'micro-adventure', budget:'paid', location:'home', costEstimate:'$3–$10 depending on snacks', duration:'20–30 minutes', equipment:['A few snacks','Plates'], mission:'Find your shared favorite and the most surprising flavor.', howToPlay:['Each person selects two or three snacks within the agreed budget.','Taste each one and privately rate it from 1 to 5.','Reveal ratings together and name the shared winner.'], importantRule:'Check allergies and dietary needs first; never use mystery ingredients.', gradient:'linear-gradient(135deg, #0f766e, #0c4a6e)' },
    { id:'viral-05', title:'Tiny Tourist Challenge', detail:'Act like tourists in a familiar area and discover one detail you have never noticed.', category:'micro-adventure', budget:'free', location:'out', costEstimate:'Free; optional treat cost', duration:'30–60 minutes', equipment:['Phone camera optional'], mission:'Find a landmark, a hidden detail, and a place you would bring a visitor.', howToPlay:['Choose a familiar public area.','Each player picks one thing to investigate or photograph.','Share what you noticed and choose one new favorite spot.'], atHomeAlternative:'Explore a room or part of your home you rarely pay attention to.', gradient:'linear-gradient(135deg, #0f766e, #164e63)' },
    { id:'viral-06', title:'No-Scroll Cozy Hour', detail:'Put phones away and invent a relaxed hour using only things already at home.', category:'micro-adventure', budget:'free', location:'home', costEstimate:'Free', duration:'60 minutes', equipment:['A timer optional'], mission:'Create an hour that feels different without buying anything.', howToPlay:['Each person suggests one cozy activity.','Choose a combination such as music, a puzzle, drawing, or a short walk.','Keep phones away except for emergencies and end by sharing the best moment.'], gradient:'linear-gradient(135deg, #0f766e, #134e4a)' },
    { id:'viral-07', title:'Future Postcard Exchange', detail:'Write a postcard-style note to each other from an imagined future trip or milestone.', category:'micro-adventure', budget:'free', location:'home', costEstimate:'Free with paper', duration:'20–30 minutes', equipment:['Paper','Pens'], mission:'Describe a future memory as if it already happened.', howToPlay:['Pick an imaginary destination or future milestone.','Write each other a short postcard with two details you hope to experience.','Read them aloud and choose one idea to make real someday.'], gradient:'linear-gradient(135deg, #0f766e, #134e4a)' }
  ],
  'pack-coop': [
    { id:'coop-01', title:'Co-Op Mission Marathon', detail:'Play a cooperative game and define three team goals before starting.', category:'gaming', budget:'free', location:'home', costEstimate:'Free using a game you own', duration:'30–60 minutes', equipment:['A cooperative video game'], mission:'Complete three team goals without blaming each other for mistakes.', howToPlay:['Choose a cooperative game you both can access.','Set three goals that fit one session.','Celebrate progress after each goal, even if you do not finish all of them.'], gradient:'linear-gradient(135deg, #064e3b, #022c22)' },
    { id:'coop-02', title:'Build-a-World Relay', detail:'Take turns adding to one shared build in a game or with blocks and household craft supplies.', category:'gaming', budget:'free', location:'home', costEstimate:'Free using owned games or supplies', duration:'30–45 minutes', equipment:['Building game, blocks, or craft supplies'], mission:'Build one place that combines both of your ideas.', howToPlay:['Player 1 adds the foundation and explains the idea.','Player 2 adds a new feature without removing the first idea.','Alternate turns until you have a shared creation.'], gradient:'linear-gradient(135deg, #064e3b, #14532d)' },
    { id:'coop-03', title:'Puzzle Partners', detail:'Choose a puzzle game or physical puzzle and solve it together under a relaxed time limit.', category:'gaming', budget:'free', location:'home', costEstimate:'Free using an owned puzzle or game', duration:'20–45 minutes', equipment:['Puzzle or puzzle game'], mission:'Solve one puzzle while explaining your thinking to each other.', howToPlay:['Pick a puzzle suited to both players.','Take turns proposing approaches; the other person gets to test the idea.','If you get stuck, allow one hint and keep going.'], gradient:'linear-gradient(135deg, #064e3b, #022c22)' },
    { id:'coop-04', title:'Co-Op Challenge Wheel', detail:'Write five small game challenges and randomly choose which one to attempt together.', category:'gaming', budget:'free', location:'home', costEstimate:'Free with a game you own', duration:'30 minutes', equipment:['A game you both can access','Paper optional'], mission:'Complete three randomly selected team challenges.', howToPlay:['Write five doable challenges for your chosen game.','Randomly pick one and attempt it as a team.','Repeat until you complete three or agree on a new challenge.'], gradient:'linear-gradient(135deg, #064e3b, #166534)' },
    { id:'coop-05', title:'Board Game Teach-Back', detail:'Choose a board game one of you knows and learn it by having the teacher explain only one step at a time.', category:'board games', budget:'free', location:'home', costEstimate:'Free using a game you own', duration:'30–60 minutes', equipment:['A board or card game'], mission:'Learn a game together without rushing through the rules.', howToPlay:['Choose a game you already own.','The experienced player explains the goal and first turn only.','Play a practice round, then add any remaining rules before the real game.'], gradient:'linear-gradient(135deg, #064e3b, #312e81)' },
    { id:'coop-06', title:'Two-Person Tabletop Campaign', detail:'Create a short, silly story using a tabletop game, cards, dice, or paper prompts.', category:'board games', budget:'free', location:'home', costEstimate:'Free with household materials', duration:'30–45 minutes', equipment:['Paper or cards','Dice optional'], mission:'Make a tiny story with a beginning, twist, and ending.', howToPlay:['Each person invents a character and one goal.','Take turns drawing a card or rolling a die to introduce a complication.','Work together to resolve the story in three scenes.'], gradient:'linear-gradient(135deg, #064e3b, #1e3a8a)' },
    { id:'coop-07', title:'Friendly Rematch League', detail:'Play three short rounds of a game and score the session on teamwork, creativity, and laughs—not just wins.', category:'board games', budget:'free', location:'home', costEstimate:'Free using an owned game', duration:'30–45 minutes', equipment:['A quick game'], mission:'Finish a three-round mini league and award playful titles.', howToPlay:['Choose a game that supports quick rounds.','After each round, give one point for teamwork, one for creativity, and one for the funniest moment.','Total the points and invent a silly award for each player.'], gradient:'linear-gradient(135deg, #064e3b, #312e81)' }
  ],
  'pack-sweet': [
    { id:'sweet-01', title:'Decorate-the-Same Dessert', detail:'Bake or buy a simple dessert base, then decorate two versions from the same set of toppings.', category:'baking', budget:'paid', location:'home', costEstimate:'$5–$12 depending on ingredients', duration:'30–60 minutes', equipment:['Cookies or cupcakes','Simple toppings'], mission:'Make two desserts that look totally different but share the same ingredients.', howToPlay:['Choose a dessert base and agree on toppings.','Decorate each other’s dessert or make one each.','Reveal them together and choose playful award categories.'], importantRule:'Check allergies and keep food preparation hygienic.', gradient:'linear-gradient(135deg, #4a1525, #831843)' },
    { id:'sweet-02', title:'Two-Flavor Cookie Test', detail:'Make one simple cookie dough and split it into two portions with different mix-ins.', category:'baking', budget:'paid', location:'home', costEstimate:'$6–$12 for ingredients', duration:'45–75 minutes', equipment:['Cookie ingredients','Mix-ins'], mission:'Test two flavor combinations and crown the shared favorite.', howToPlay:['Pick a basic cookie recipe.','Divide the dough and add a different mix-in to each half.','Bake safely, taste when cooled, and rate both flavors.'], importantRule:'Check dietary restrictions and follow the recipe’s baking instructions.', gradient:'linear-gradient(135deg, #4a1525, #9f1239)' },
    { id:'sweet-03', title:'No-Bake Sweet Creation', detail:'Create a no-bake dessert using ingredients you already have or choose within a set budget.', category:'baking', budget:'paid', location:'home', costEstimate:'$3–$10 depending on ingredients', duration:'20–35 minutes', equipment:['No-bake dessert ingredients'], mission:'Make a dessert that looks fancy without using the oven.', howToPlay:['Choose a safe no-bake recipe.','Divide tasks so both people contribute.','Plate the dessert and give it a restaurant-style name.'], importantRule:'Keep perishable ingredients refrigerated as needed.', gradient:'linear-gradient(135deg, #4a1525, #701a75)' },
    { id:'sweet-04', title:'Mystery Pantry Bake-Off', detail:'Choose three compatible ingredients from your pantry and use them to inspire a simple baked treat.', category:'baking', budget:'paid', location:'home', costEstimate:'$5–$15 depending on what you have', duration:'45–75 minutes', equipment:['Pantry ingredients','Baking tools'], mission:'Invent a flavor combination that still makes sense as dessert.', howToPlay:['Agree on a small ingredient budget and check what is available.','Choose three inspiration ingredients that work safely together.','Use a reliable recipe as the base and add your twist.'], importantRule:'Do not use unknown ingredients; check allergens and food safety.', gradient:'linear-gradient(135deg, #4a1525, #831843)' },
    { id:'sweet-05', title:'Dessert Plating Contest', detail:'Plate the same dessert in two different styles and present each like a restaurant special.', category:'baking', budget:'paid', location:'home', costEstimate:'$4–$12 depending on dessert', duration:'20–30 minutes', equipment:['Dessert','Plates','Optional fruit or sauce'], mission:'Make an everyday dessert look celebration-worthy.', howToPlay:['Pick one dessert.','Each person plates a portion in their own style.','Present the dish and judge creativity, neatness, and taste.'], gradient:'linear-gradient(135deg, #4a1525, #9f1239)' },
    { id:'sweet-06', title:'Sweet-and-Salty Pairing', detail:'Build a small tasting plate that contrasts sweet and salty flavors.', category:'baking', budget:'paid', location:'home', costEstimate:'$4–$10 depending on snacks', duration:'20–30 minutes', equipment:['A few sweet and salty snacks'], mission:'Find a pairing that tastes better together than separately.', howToPlay:['Choose three small sweet and salty combinations.','Taste each combination and discuss the contrast.','Pick a favorite and write down the winning pairing.'], importantRule:'Check allergies and dietary requirements before tasting.', gradient:'linear-gradient(135deg, #4a1525, #701a75)' },
    { id:'sweet-07', title:'Breakfast-for-Dessert Bake', detail:'Make a sweet breakfast-inspired treat together, such as cinnamon toast bites or baked fruit crumble.', category:'baking', budget:'paid', location:'home', costEstimate:'$5–$12 for ingredients', duration:'30–60 minutes', equipment:['Simple baking ingredients','Oven-safe dish if needed'], mission:'Turn a familiar breakfast flavor into a cozy dessert.', howToPlay:['Choose a recipe that matches your time and equipment.','Split preparation tasks and prepare the treat together.','Serve it as dessert and name your creation.'], importantRule:'Use oven mitts and follow safe cooking temperatures.', gradient:'linear-gradient(135deg, #4a1525, #831843)' }
  ],
  'pack-quest': [
    { id:'questpack-01', title:'Three-Clue Destination Quest', detail:'One partner creates three clues leading to a safe public destination; the other solves them along the way.', category:'quest', budget:'free', location:'out', costEstimate:'Free; optional snack cost', duration:'30–60 minutes', equipment:['Paper or phone notes'], mission:'Reach a destination by solving three simple clues.', howToPlay:['Choose a familiar public route and a safe destination.','Write three clues based on public landmarks.','Take turns solving each clue before moving on.'], importantRule:'Do not trespass or use clues that require unsafe travel.', gradient:'linear-gradient(135deg, #1e293b, #0f172a)' },
    { id:'questpack-02', title:'Local Landmark Bingo', detail:'Make a short bingo card of visible things you might notice during a neighborhood walk.', category:'quest', budget:'free', location:'out', costEstimate:'Free', duration:'30–45 minutes', equipment:['Paper or phone notes'], mission:'Spot five bingo items during a walk together.', howToPlay:['Write nine things visible from public areas, such as a mural, a red door, or a bird.','Walk a safe route and mark each item you spot.','First to five wins, or complete the whole card as a team.'], importantRule:'Stay aware of traffic and surroundings while walking.', gradient:'linear-gradient(135deg, #1e293b, #1d4ed8)' },
    { id:'questpack-03', title:'At-Home Escape Clues', detail:'Build a mini escape-room chain with clues hidden around one room.', category:'quest', budget:'free', location:'home', costEstimate:'Free with household items', duration:'20–40 minutes', equipment:['Paper','Pens','Household objects'], mission:'Solve three linked clues to reveal a final message.', howToPlay:['Choose a final answer or message.','Write three clues that lead to it and place them in ordinary, safe spots.','Let your partner solve the clues, then switch roles.'], importantRule:'Do not lock doors or hide anything near hazards.', gradient:'linear-gradient(135deg, #1e293b, #312e81)' },
    { id:'questpack-04', title:'Secret Compliment Trail', detail:'Leave a sequence of clues that reveal small compliments or favorite memories.', category:'quest', budget:'free', location:'home', costEstimate:'Free with paper', duration:'15–30 minutes', equipment:['Small notes','Pen'], mission:'Make the final clue reveal a thoughtful message.', howToPlay:['Write three sincere compliments or memories.','Attach a simple clue to each note.','Let your partner follow the trail, then swap and repeat.'], gradient:'linear-gradient(135deg, #1e293b, #4c1d95)' },
    { id:'questpack-05', title:'Park Detail Discovery', detail:'Visit a public park and choose a small observation challenge instead of a long hike.', category:'quest', budget:'free', location:'out', costEstimate:'Free', duration:'25–45 minutes', equipment:['Phone camera optional'], mission:'Find a natural pattern, a peaceful spot, and something that makes you smile.', howToPlay:['Choose a park and a comfortable route.','Each player picks one thing to observe without disturbing wildlife or plants.','Share observations and choose your favorite spot.'], importantRule:'Follow park rules and leave plants, animals, and surroundings undisturbed.', gradient:'linear-gradient(135deg, #1e293b, #14532d)' },
    { id:'questpack-06', title:'The $5-or-Free Quest', detail:'Plan a tiny outing that costs no more than five dollars total—or costs nothing.', category:'quest', budget:'free', location:'out', costEstimate:'Free to $5 total', duration:'30–60 minutes', equipment:['None required'], mission:'Find a fun shared experience without breaking the budget.', howToPlay:['Agree on a total spending limit of $0–$5.','Choose a free public destination or an inexpensive shared treat.','At the end, name the best moment that cost nothing.'], importantRule:'Travel costs may vary; keep the agreed budget realistic.', gradient:'linear-gradient(135deg, #1e293b, #0f766e)' },
    { id:'questpack-07', title:'Memory Map Quest', detail:'Draw a tiny map of places that have mattered to your relationship or friendship.', category:'quest', budget:'free', location:'home', costEstimate:'Free with paper', duration:'20–40 minutes', equipment:['Paper','Pens'], mission:'Create a map with three places and the story behind each one.', howToPlay:['Sketch a simple map, real or imaginary.','Mark three meaningful places and add a short memory to each.','Trade maps and ask one question about each place.'], gradient:'linear-gradient(135deg, #1e293b, #312e81)' }
  ],
  'pack-arcade': [
    { id:'arcadepack-01', title:'Paper Ball Bullseye', detail:'Use soft paper balls and a bin to make a three-round target contest.', category:'arcade', budget:'free', location:'home', costEstimate:'Free with scrap paper and a bin', duration:'10–20 minutes', equipment:['Scrap paper','Bin or basket'], mission:'Score points by landing paper balls in the target.', howToPlay:['Place a bin at a safe, agreed distance.','Give each player five paper-ball throws per round.','Play three rounds, moving the target slightly farther away if both agree.'], importantRule:'Use paper only and keep the area clear of fragile items.', gradient:'linear-gradient(135deg, #581c87, #3b0764)' },
    { id:'arcadepack-02', title:'Speed Stack Showdown', detail:'Race to stack and unstack a safe set of cups or lightweight containers.', category:'arcade', budget:'free', location:'home', costEstimate:'Free with cups or containers', duration:'10–15 minutes', equipment:['Lightweight cups or containers'], mission:'Complete three rounds without knocking over the stack.', howToPlay:['Build a simple pyramid with lightweight cups.','Time each player stacking and unstacking it.','Best two of three rounds wins.'], importantRule:'Use lightweight items and a stable surface.', gradient:'linear-gradient(135deg, #581c87, #701a75)' },
    { id:'arcadepack-03', title:'One-Minute Drawing Duel', detail:'Draw the same silly prompt in one minute, then compare the results.', category:'arcade', budget:'free', location:'home', costEstimate:'Free with paper and pens', duration:'10–20 minutes', equipment:['Paper','Pens'], mission:'Create a recognizable drawing under a one-minute timer.', howToPlay:['Choose a prompt such as a dragon, robot, or dream house.','Set a one-minute timer and draw without looking at each other’s work.','Reveal drawings and award points for funniest, most creative, and most recognizable.'], gradient:'linear-gradient(135deg, #581c87, #4c1d95)' },
    { id:'arcadepack-04', title:'Song Intro Challenge', detail:'Play a short intro from music you can legally access and guess the song or artist.', category:'arcade', budget:'free', location:'home', costEstimate:'Free if you have music access', duration:'15–25 minutes', equipment:['Music app or owned tracks'], mission:'Get the most correct guesses across ten songs.', howToPlay:['Each person queues five songs without showing the screen.','Play a few seconds of each intro and let the other guess title or artist.','Award one point per correct answer, then swap roles.'], gradient:'linear-gradient(135deg, #581c87, #312e81)' },
    { id:'arcadepack-05', title:'Memory Tray Challenge', detail:'Study a tray of safe household objects briefly, then see how many each person remembers.', category:'arcade', budget:'free', location:'home', costEstimate:'Free with household objects', duration:'10–20 minutes', equipment:['6–12 safe household objects','Tray or table'], mission:'Remember as many objects as possible after a short look.', howToPlay:['Place 6–12 safe objects on a tray.','Study them for 20 seconds, then cover them.','Write down as many as you remember and switch who arranges the tray.'], importantRule:'Avoid sharp, breakable, or hazardous objects.', gradient:'linear-gradient(135deg, #581c87, #4c1d95)' },
    { id:'arcadepack-06', title:'No-Laugh Challenge', detail:'Take turns telling a harmless silly story or making a funny face while the other tries to keep a straight face.', category:'arcade', budget:'free', location:'home', costEstimate:'Free', duration:'10–15 minutes', equipment:['None'], mission:'Stay serious for one minute, then swap roles.', howToPlay:['Agree on a one-minute round.','Take turns using harmless jokes, funny voices, or expressions.','Award one point each time the other player laughs; low score wins.'], gradient:'linear-gradient(135deg, #581c87, #701a75)' },
    { id:'arcadepack-07', title:'Best-of-Five Quickfire', detail:'Pick five short challenges from this pack and play them as a mini tournament.', category:'arcade', budget:'free', location:'home', costEstimate:'Free with household items', duration:'20–35 minutes', equipment:['Paper and pen optional','Safe household items'], mission:'Earn the most points across five quick challenges.', howToPlay:['Choose five short challenges and agree on fair rules.','Play each challenge once and record a point for each round won.','Total the scores and invent a funny championship title.'], gradient:'linear-gradient(135deg, #581c87, #3b0764)' }
  ]
};

let p1Deck = [], p2Deck = [], p1Likes = [], p2Likes = [];
let swipePlayer = 1, swipeIndex = 0, draftItems = [], draftTurn = 1;
let peer = null, conn = null, remoteRoomId = null, myPlayerNum = 1, currentRoomPeerId = null;
let remoteSubmitSent = false;
let guestRoundId = null;
let pendingCompleteEntry = null;

let remotePartnerLikes = null;
let remoteMatchResolved = false;
let p2HeartbeatTimer = null;
let connectionState = 'disconnected';

let isDragging = false, startX = 0, currentX = 0, startTime = 0;
let swipeCardEl = null;
window.currentWinner = null;

const shuffle = array => {
  const out = [...array];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

function createUniqueId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getCardScore(card) {
  let score = 5;
  const matches = dateHistory.filter(h => h.cardId === card.id || (!h.cardId && h.category === card.category));
  const ratings = [];
  matches.forEach(entry => {
    [entry.rating1, entry.rating2].forEach(value => {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 1 && n <= 5) ratings.push(n);
    });
  });
  if (ratings.length) {
    const average = ratings.reduce((sum, n) => sum + n, 0) / ratings.length;
    score += (average - 3) * 2;
  }
  return score + Math.random() * 0.5;
}

function renderPackChoices() {
  document.querySelectorAll('.pack-choice').forEach(input => {
    const packId = input.value;
    const unlocked = packId === 'starter' || unlockedItems.includes(packId);
    const selectedByHost = remoteRoomId && myPlayerNum === 2 && selectedPacks.includes(packId);
    input.checked = selectedPacks.includes(packId);
    input.disabled = Boolean(remoteRoomId && myPlayerNum === 2) || (!unlocked && !selectedByHost);

    const status = getEl(`packStatus-${packId}`);
    if (status) {
      status.textContent = packId === 'starter'
        ? 'Included'
        : unlocked
          ? (selectedPacks.includes(packId) ? 'Selected' : 'Unlocked')
          : (selectedByHost ? 'Host selected' : 'Locked · Store');
    }
  });

  const summary = getEl('categorySummary');
  if (summary) {
    const packText = selectedPacks.length === 1 ? '1 pack' : `${selectedPacks.length} packs`;
    summary.textContent = `${packText} selected · ${activeDeck.length} ideas ▾`;
  }
}

function refreshDecks() {
  const libraryCards = [...masterDeck, ...customDeck];
  unlockedItems.forEach(packId => {
    if (expansionDecks[packId]) libraryCards.push(...expansionDecks[packId]);
  });
  fullDeck = libraryCards.filter(item => !deletedBuiltins.has(item.id));

  const checkboxes = document.querySelectorAll('.category-choice');
  if (checkboxes.length) {
    selectedCategories = [...checkboxes].filter(input => input.checked).map(input => input.value);
  }

  const chosenCards = [];
  if (selectedPacks.includes('starter')) chosenCards.push(...masterDeck, ...customDeck);
  unlockedItems.forEach(packId => {
    if (selectedPacks.includes(packId) && expansionDecks[packId]) {
      chosenCards.push(...expansionDecks[packId]);
    }
  });

  const budgetFilterEl = getEl('budgetFilter');
  const budget = budgetFilterEl ? budgetFilterEl.value : 'all';
  activeDeck = chosenCards.filter(item => {
    const notDeleted = !deletedBuiltins.has(item.id);
    const categoryMatches = selectedCategories.includes(item.category);
    const budgetMatches = budget === 'all' || item.budget === budget;
    return notDeleted && categoryMatches && budgetMatches;
  });
  activeDeck.sort((a, b) => getCardScore(b) - getCardScore(a));
  renderPackChoices();
}

async function applyPackFilter() {
  const previousPacks = [...selectedPacks];
  const checkedPacks = [...document.querySelectorAll('.pack-choice:checked')].map(input => input.value);
  selectedPacks = [...new Set(checkedPacks.filter(packId =>
    packId === 'starter' || unlockedItems.includes(packId) ||
    (remoteRoomId && myPlayerNum === 2 && previousPacks.includes(packId))
  ))];

  if (!useMemoryFallback && db && !(remoteRoomId && myPlayerNum === 2)) {
    try { await db.settings.put({ key: 'selectedPacks', value: selectedPacks }); }
    catch (err) { console.error('Could not save selected packs:', err); }
  }

  refreshDecks();
  if (remoteRoomId && myPlayerNum === 2) {
    if (getEl('card-library')?.classList.contains('active-mode')) renderLibrary();
    return;
  }

  if (remoteRoomId && myPlayerNum === 1) {
    resetRemoteRound();
    sendRoomState();
  } else {
    initMatcher();
  }
  if (getEl('card-library')?.classList.contains('active-mode')) renderLibrary();
}

async function applyCategoryFilter() {
  selectedCategories = [...document.querySelectorAll('.category-choice:checked')].map(input => input.value);
  if (!useMemoryFallback && db) {
    try { await db.categories.put({ id: 'selectedCats', values: selectedCategories }); }
    catch (err) { console.error('Could not save category filters:', err); }
  }
  refreshDecks();

  if (remoteRoomId && myPlayerNum === 2) {
    if (getEl('card-library')?.classList.contains('active-mode')) renderLibrary();
    return;
  }

  if (remoteRoomId && myPlayerNum === 1) {
    resetRemoteRound();
    sendRoomState();
  } else {
    initMatcher();
  }
  if (getEl('card-library')?.classList.contains('active-mode')) renderLibrary();
}

function setAllCategories(checked) {
  const picker = getEl('categoryPicker');
  if (picker) picker.open = true;
  document.querySelectorAll('.category-choice').forEach(input => { input.checked = checked; });
  applyCategoryFilter();
  if (picker) picker.open = true;
}

function switchGame(mode, button = null) {
  const allowedViews = new Set(['matcher', 'surprise', 'history', 'library', 'store']);
  if (!allowedViews.has(mode)) return;

  const picker = getEl('categoryPicker');
  if (picker) picker.open = false;

  const target = getEl(`card-${mode}`);
  if (!target) return;

  document.querySelectorAll('.game-card').forEach(card => card.classList.remove('active-mode'));
  target.classList.add('active-mode');

  if (mode === 'matcher' || mode === 'surprise') {
    const primaryButton = button || document.querySelector(`.nav-tab[data-mode="${mode}"]`);
    document.querySelectorAll('.nav-tab').forEach(tab => tab.classList.remove('active'));
    if (primaryButton) primaryButton.classList.add('active');
  }

  if (mode === 'matcher') updateSwipeCard();
  if (mode === 'library') renderLibrary();
  if (mode === 'history') renderHistory();
  if (mode === 'store') renderStore();
}

document.addEventListener('click', event => {
  const picker = getEl('categoryPicker');
  if (picker && picker.open && !picker.contains(event.target)) picker.open = false;
});

function currentSwipeDeck() {
  if (remoteRoomId) return myPlayerNum === 1 ? p1Deck : p2Deck;
  return swipePlayer === 1 ? p1Deck : p2Deck;
}

function initMatcher() {
  p1Deck = shuffle(activeDeck);
  p2Deck = [...p1Deck];
  p1Likes = [];
  p2Likes = [];
  swipePlayer = 1;
  swipeIndex = 0;
  remoteSubmitSent = false;
  remotePartnerLikes = null;
  remoteMatchResolved = false;
  window.currentWinner = null;
  draftItems = [];
  draftTurn = 1;
  const votingModal = getEl('votingModal');
  if (votingModal) votingModal.classList.remove('show');
  const noMatchesActions = getEl('noMatchesActions');
  if (noMatchesActions) noMatchesActions.hidden = true;
  updateSwipeCard();
}

function updateConnectionBanner() {
  const statusBanner = getEl('connectionStatusBanner');
  if (!statusBanner) return;
  if (remoteRoomId) {
    statusBanner.style.display = 'block';
    if (conn && conn.open) {
      statusBanner.className = 'connection-status-banner connected';
      statusBanner.textContent = `🟢 Connected to Room "${remoteRoomId}" (Player ${myPlayerNum})`;
    } else {
      statusBanner.className = 'connection-status-banner disconnected';
      statusBanner.textContent = `🔴 ${connectionState === 'waiting' ? 'Waiting for partner to join...' : 'Disconnected from room. Reconnecting...'}`;
    }
  } else {
    statusBanner.style.display = 'none';
  }
}

function updateSwipeCard() {
  const header = getEl('matcherTurnHeader');
  const cardEl = getEl('swipeCard');
  const metaEl = getEl('cardMeta');
  const venueHint = getEl('venueHintBanner');
  if (!header || !cardEl) return;

  updateConnectionBanner();

  const curDeck = currentSwipeDeck();
  if (!curDeck.length) {
    header.textContent = 'No matching date ideas';
    cardEl.style.background = '#1f122e';

    const catEl = getEl('cardCategory');
    if (catEl) catEl.textContent = 'No cards';

    const titleEl = getEl('cardTitle');
    if (titleEl) titleEl.textContent = 'Adjust your packs';

    const detailEl = getEl('cardDetail');
    if (detailEl) {
      if (remoteRoomId && myPlayerNum === 2 && !guestRoundId) {
        detailEl.textContent = 'Waiting for the host to send the shared date deck…';
      } else if (!selectedPacks.length) {
        detailEl.textContent = 'Select at least one pack in Filters & Preferences to start Matcher.';
      } else if (!selectedCategories.length) {
        detailEl.textContent = 'Select at least one category in Filters & Preferences.';
      } else {
        detailEl.textContent = 'No cards match the selected packs, categories, and budget. Choose more packs/categories or select Any Budget.';
      }
    }

    if (metaEl) metaEl.replaceChildren();
    if (venueHint) venueHint.style.display = 'none';
    return;
  }

  if (remoteRoomId) {
    header.textContent = `Live Room (${remoteRoomId}) · Player ${myPlayerNum} · Card ${Math.min(swipeIndex + 1, curDeck.length)} of ${curDeck.length}`;
  } else {
    header.textContent = `Player ${swipePlayer}'s Turn · Card ${Math.min(swipeIndex + 1, curDeck.length)} of ${curDeck.length}`;
  }

  if (swipeIndex >= curDeck.length) {
    if (remoteRoomId) {
      if (!conn || !conn.open) {
        header.textContent = 'Live room disconnected · Rejoin or check connection';
      } else if (myPlayerNum === 2) {
        if (!remoteSubmitSent) {
          remoteSubmitSent = sendP2PMessage({
            type: 'SUBMIT_SWIPES',
            likedCards: p2Likes
          });
        }
        header.textContent = 'All cards reviewed · Waiting for mutual match result from Host…';
      } else {
        if (tryResolveRemoteMatch()) return;
        header.textContent = remotePartnerLikes !== null
          ? 'Partner finished · Resolving mutual match…'
          : 'All cards reviewed · Waiting for partner to finish…';
      }

      const catEl = getEl('cardCategory'); if (catEl) catEl.textContent = 'Swiping complete';
      const titleEl = getEl('cardTitle'); if (titleEl) titleEl.textContent = 'Waiting for mutual match';
      const detailEl = getEl('cardDetail'); if (detailEl) detailEl.textContent = myPlayerNum === 1
        ? 'Comparing partner selections and opening mutual draft elimination.'
        : 'Your selections have been securely submitted. Waiting for host resolution.';

      cardEl.style.background = '#1f122e';
      if (metaEl) metaEl.replaceChildren();
      if (venueHint) venueHint.style.display = 'none';
      return;
    }

    if (swipePlayer === 1) {
      swipePlayer = 2;
      swipeIndex = 0;
      showToast("Player 1 complete! Pass the phone to Player 2.");
      updateSwipeCard();
    } else {
      const mutual = p1Likes.filter(a => p2Likes.some(b => b.id === a.id));
      handleMatchOutcome(mutual);
    }
    return;
  }

  const item = curDeck[swipeIndex];
  cardEl.style.background = item.gradient || '#1f122e';
  const catEl = getEl('cardCategory'); if (catEl) catEl.textContent = item.category || 'Date idea';
  const titleEl = getEl('cardTitle'); if (titleEl) titleEl.textContent = item.title || 'Untitled date';
  const detailEl = getEl('cardDetail'); if (detailEl) detailEl.textContent = item.detail || '';
  
  if (metaEl) {
    const locLabel = item.location === 'home'
      ? '🏠 Stay Home'
      : item.location === 'out'
        ? '🚗 Go Out'
        : '🌐 Either';

    const costPill = document.createElement('span');
    costPill.className = 'meta-pill';
    costPill.textContent = `💰 ${item.budget === 'free' ? 'Free' : (item.costEstimate || 'Paid')}`;

    const locationPill = document.createElement('span');
    locationPill.className = 'meta-pill';
    locationPill.textContent = locLabel;

    metaEl.replaceChildren(costPill, locationPill);
  }

  if (venueHint) venueHint.style.display = item.location === 'out' ? 'block' : 'none';
}

function handleSwipe(liked) {
  const curDeck = currentSwipeDeck();

  if (remoteRoomId && (!conn || !conn.open)) {
    showToast('The live-room connection is not ready. Reconnect before swiping.');
    return;
  }
  if (!curDeck.length || swipeIndex >= curDeck.length) return;

  const likes = remoteRoomId
    ? (myPlayerNum === 1 ? p1Likes : p2Likes)
    : (swipePlayer === 1 ? p1Likes : p2Likes);

  playSound('swipe');
  triggerHaptic('light');
  if (liked) likes.push(curDeck[swipeIndex]);
  swipeIndex += 1;
  updateSwipeCard();
}

function installSwipeGestures() {
  swipeCardEl = getEl('swipeCard');
  if (!swipeCardEl) return;
  swipeCardEl.addEventListener('mousedown', dragStart);
  swipeCardEl.addEventListener('touchstart', dragStart, { passive: true });

  function dragStart(event) {
    const deck = currentSwipeDeck();
    if (swipeIndex >= deck.length || (remoteRoomId && (!conn || !conn.open))) return;
    isDragging = true;
    startX = event.type.includes('mouse') ? event.clientX : event.touches[0].clientX;
    currentX = 0;
    startTime = performance.now();
    swipeCardEl.style.transition = 'none';
    window.addEventListener('mousemove', dragMove);
    window.addEventListener('mouseup', dragEnd);
    window.addEventListener('touchmove', dragMove, { passive: true });
    window.addEventListener('touchend', dragEnd);
    window.addEventListener('touchcancel', dragEnd);
  }

  function dragMove(event) {
    if (!isDragging) return;
    const x = event.type.includes('mouse') ? event.clientX : event.touches?.[0]?.clientX;
    if (typeof x !== 'number') return;
    currentX = x - startX;
    swipeCardEl.style.transform = `translateX(${x - startX}px) rotate(${(x - startX) * 0.04}deg)`;
  }

  function dragEnd() {
    if (!isDragging) return;
    isDragging = false;
    window.removeEventListener('mousemove', dragMove);
    window.removeEventListener('mouseup', dragEnd);
    window.removeEventListener('touchmove', dragMove);
    window.removeEventListener('touchend', dragEnd);
    window.removeEventListener('touchcancel', dragEnd);
    swipeCardEl.style.transition = 'transform 0.3s ease, opacity 0.3s ease';

    const elapsed = (performance.now() - startTime) / 1000;
    const velocity = Math.abs(currentX / (elapsed || 0.001));
    const threshold = velocity > 400 ? 40 : 80;
    const wasLike = currentX > threshold;
    const wasPass = currentX < -threshold;
    currentX = 0;

    if (wasLike || wasPass) {
      swipeCardEl.style.transform = `translateX(${wasLike ? 350 : -350}px) rotate(${wasLike ? 25 : -25}deg)`;
      swipeCardEl.style.opacity = '0';
      window.setTimeout(() => {
        handleSwipe(wasLike);
        resetSwipeCard();
      }, 220);
    } else {
      swipeCardEl.style.transform = 'translateX(0) rotate(0)';
    }
  }
}

function resetSwipeCard() {
  if (!swipeCardEl) return;
  swipeCardEl.style.transform = 'translateX(0) rotate(0)';
  swipeCardEl.style.opacity = '1';
}

function handleMatchOutcome(mutual, forcedWinner = null) {
  if (forcedWinner) {
    window.currentWinner = forcedWinner;
    const isMutual = Array.isArray(mutual) && mutual.some(item => item.id === forcedWinner.id);
    showModal(isMutual ? 'It’s a Match!' : 'Date Decided!', forcedWinner.title, forcedWinner.detail);
    return;
  }

  const unique = new Map();
  (Array.isArray(mutual) ? mutual : []).forEach(item => {
    const safe = sanitizeCard(item);
    if (safe) unique.set(safe.id, safe);
  });
  const mutualOptions = [...unique.values()];

  if (mutualOptions.length === 0) {
    if (remoteRoomId && myPlayerNum === 1) sendP2PMessage({ type: 'NO_MUTUAL_MATCHES' });
    showNoMutualMatches();
    return;
  }

  if (mutualOptions.length === 1) {
    const winner = mutualOptions[0];
    window.currentWinner = winner;
    if (remoteRoomId && myPlayerNum === 1) {
      sendP2PMessage({ type: 'MATCH_WINNER', winnerId: winner.id });
    }
    showModal('It’s a Match!', winner.title, winner.detail);
    return;
  }

  startMutualDraft(mutualOptions);
}

function showNoMutualMatches() {
  window.currentWinner = null;
  draftItems = [];

  const modal = getEl('votingModal');
  const eyebrow = getEl('votingEyebrow');
  const title = getEl('votingModalTitle');
  const detail = getEl('votingModalDetail');
  const container = getEl('votingShortlistContainer');
  const actions = getEl('noMatchesActions');

  if (eyebrow) eyebrow.textContent = 'No Mutual Matches';
  if (title) title.textContent = 'Nothing Matched This Round';
  if (detail) detail.textContent = 'You both need to like the same idea for it to enter the elimination draft. No unrelated suggestions will be added. Adjust your selected packs or categories and play another round.';
  if (container) container.replaceChildren();
  if (actions) actions.hidden = false;
  if (modal) modal.classList.add('show');
}

function restartMatcherAfterNoMatch() {
  const modal = getEl('votingModal');
  if (modal) modal.classList.remove('show');
  const actions = getEl('noMatchesActions');
  if (actions) actions.hidden = true;

  if (remoteRoomId && myPlayerNum === 2) {
    const sent = sendP2PMessage({ type: 'REQUEST_NEW_ROUND' });
    showToast(sent ? 'Asked the host to restart Matcher with the same packs.' : 'Could not reach the host. Reconnect and try again.');
    return;
  }

  if (remoteRoomId && myPlayerNum === 1) {
    resetRemoteRound();
    sendRoomState();
    showToast('New Matcher round started with the same packs.');
    return;
  }

  initMatcher();
  showToast('New Matcher round started with the same packs.');
}

function requestPackAdjustment() {
  const modal = getEl('votingModal');
  if (modal) modal.classList.remove('show');
  const actions = getEl('noMatchesActions');
  if (actions) actions.hidden = true;

  if (remoteRoomId && myPlayerNum === 2) {
    const sent = sendP2PMessage({ type: 'REQUEST_FILTER_CHANGE' });
    showToast(sent ? 'Asked the host to adjust the selected packs.' : 'Could not reach the host. Reconnect and try again.');
    return;
  }

  const picker = getEl('categoryPicker');
  if (picker) picker.open = true;
  const summary = getEl('categorySummary');
  if (summary) summary.focus();
  showToast('Adjust your selected packs or categories, then start a new round.');
}

function startMutualDraft(items) {
  const unique = new Map();
  (Array.isArray(items) ? items : []).forEach(item => {
    const safe = sanitizeCard(item);
    if (safe) unique.set(safe.id, safe);
  });
  const mutualOptions = [...unique.values()];

  if (mutualOptions.length === 0) {
    showNoMutualMatches();
    return;
  }
  if (mutualOptions.length === 1) {
    handleMatchOutcome(mutualOptions);
    return;
  }

  draftItems = mutualOptions.map(item => ({ ...item, banned: false }));
  draftTurn = 1;
  const actions = getEl('noMatchesActions');
  if (actions) actions.hidden = true;
  const eyebrow = getEl('votingEyebrow');
  const title = getEl('votingModalTitle');
  if (eyebrow) eyebrow.textContent = 'Mutual Match Draft';
  if (title) title.textContent = 'Take Turns Eliminating';
  renderDraftGrid();

  if (remoteRoomId && myPlayerNum === 1) {
    sendP2PMessage({ type: 'MUTUAL_DRAFT_START', draftItems, draftTurn });
  }

  const modal = getEl('votingModal');
  if (modal) modal.classList.add('show');
}

function renderDraftGrid() {
  const header = getEl('draftTurnHeader');
  if (header) {
    header.textContent = remoteRoomId
      ? `Live Room (${remoteRoomId}) · Player ${draftTurn}'s Turn to Ban`
      : `Player ${draftTurn}'s Turn to Ban`;
  }

  const grid = getEl('votingShortlistContainer');
  if (!grid) return;

  if (!draftItems.length) {
    grid.replaceChildren();
    return;
  }

  const remainingCount = draftItems.filter(item => !item.banned).length;
  const detail = getEl('votingModalDetail');
  if (detail) {
    detail.textContent = `${remainingCount} mutual option${remainingCount === 1 ? '' : 's'} remain. On your turn, eliminate one option; the other player then chooses the next one to eliminate.`;
  }
  const noMatchesActions = getEl('noMatchesActions');
  if (noMatchesActions) noMatchesActions.hidden = true;

  grid.replaceChildren();
  draftItems.forEach((item, index) => {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = `draft-tile${item.banned ? ' banned' : ''}`;
    tile.dataset.cardId = item.id;
    tile.style.background = item.gradient || '#1f122e';
    tile.disabled = Boolean(item.banned);

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = item.title || 'Untitled date';

    const category = document.createElement('div');
    category.className = 'cat';
    category.textContent = item.category || '';

    tile.append(title, category);

    if (!item.banned) {
      tile.addEventListener('click', () => {
        banItem(index);
      });
    }
    grid.appendChild(tile);
  });
}

function executeBan(index) {
  if (!draftItems[index] || draftItems[index].banned) return;
  draftItems[index].banned = true;
  playSound('ban');
  triggerHaptic('heavy');

  const remaining = draftItems.filter(item => !item.banned);
  if (remaining.length > 1) {
    draftTurn = draftTurn === 1 ? 2 : 1;
  }
  renderDraftGrid();

  if (remoteRoomId && myPlayerNum === 1) {
    sendP2PMessage({ type: 'DRAFT_STATE', draftItems, draftTurn });
  }

  if (remaining.length === 1) {
    const winner = remaining[0];
    window.currentWinner = winner;
    const votingModal = getEl('votingModal');
    if (votingModal) votingModal.classList.remove('show');
    showModal('Winner by Elimination!', winner.title, winner.detail);
  }
}

function banItem(index) {
  if (remoteRoomId) {
    if (String(myPlayerNum) !== String(draftTurn)) {
      showToast(`It is currently Player ${draftTurn}'s turn to ban!`);
      return;
    }
    if (myPlayerNum === 2) {
      sendP2PMessage({ type: 'BAN_REQUEST', index });
      return;
    }
  }
  executeBan(index);
}

function surpriseMe() {
  let pool = [...activeDeck];
  const surpriseModeEl = getEl('surpriseMode');
  const mode = surpriseModeEl ? surpriseModeEl.value : 'all';
  if (mode === 'new') {
    pool = pool.filter(item => !dateHistory.some(entry => entry.cardId === item.id || (!entry.cardId && entry.title === item.title)));
  }
  if (!pool.length) {
    window.currentWinner = null;
    showModal('No Matching Dates', 'Try selecting more packs', 'There are no ideas matching your active filters that have not already been completed.');
    return;
  }
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  window.currentWinner = chosen;
  showModal('Your Surprise Date', chosen.title, chosen.detail);
}

function renderLibrary() {
  const librarySearchEl = getEl('librarySearch');
  const libraryCategoryEl = getEl('libraryCategory');
  const query = librarySearchEl ? librarySearchEl.value.trim().toLowerCase() : '';
  const category = libraryCategoryEl ? libraryCategoryEl.value : 'all';
  const list = getEl('libraryList');
  const summary = getEl('librarySummary');
  if (!list) return;
  const items = fullDeck.filter(item =>
    (category === 'all' || item.category === category) &&
    (!query || `${item.title} ${item.detail}`.toLowerCase().includes(query))
  );
  if (summary) summary.textContent = `${fullDeck.length} total ideas · Showing ${items.length}`;
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'library-summary';
    empty.textContent = 'No ideas match your search.';
    list.appendChild(empty);
    return;
  }
  items.forEach(item => {
    const card = document.createElement('article');
    card.className = 'library-item';
    const categoryEl = document.createElement('div');
    categoryEl.className = 'library-category';
    categoryEl.textContent = `${item.category} · Location: ${item.location || 'either'}`;
    const titleEl = document.createElement('div');
    titleEl.className = 'library-title';
    titleEl.textContent = item.title;
    const detailEl = document.createElement('div');
    detailEl.className = 'library-detail';
    detailEl.textContent = item.detail;
    card.append(categoryEl, titleEl, detailEl);
    list.appendChild(card);
  });
}

function renderStore() {
  const grid = getEl('storeGrid');
  const summary = getEl('storeSummary');
  if (!grid) return;
  if (summary) summary.textContent = `${storeCatalog.length} packs available · ${unlockedItems.length} unlocked`;
  grid.replaceChildren();
  storeCatalog.forEach(item => {
    const unlocked = unlockedItems.includes(item.id);
    const card = document.createElement('article');
    card.className = 'library-item store-tile';
    card.style.background = item.gradient || '#1f122e';
    const category = document.createElement('div');
    category.className = 'library-category';
    category.textContent = `EXPANSION PACK · ${item.price}`;
    const title = document.createElement('div');
    title.className = 'library-title';
    title.textContent = item.title;
    const detail = document.createElement('div');
    detail.className = 'library-detail';
    detail.textContent = item.desc;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `primary-btn${unlocked ? ' secondary-action-btn' : ''}`;
    button.style.marginTop = '10px';
    button.style.padding = '8px 12px';
    button.style.fontSize = '0.8rem';
    button.textContent = unlocked ? '✅ Unlocked & Available' : `🔓 Unlock Pack · ${item.price}`;
    button.addEventListener('click', () => openStorePreview(item.id));
    card.append(category, title, detail, button);
    grid.appendChild(card);
  });
}

function openStorePreview(itemId) {
  const item = storeCatalog.find(entry => entry.id === itemId);
  if (!item) return;
  selectedPreviewItemId = itemId;
  const storeModalTitle = getEl('storeModalTitle'); if (storeModalTitle) storeModalTitle.textContent = item.title;
  const storeModalDesc = getEl('storeModalDesc'); if (storeModalDesc) storeModalDesc.textContent = item.desc;
  const unlocked = unlockedItems.includes(itemId);
  const actionButton = getEl('storeModalActionBtn');
  if (actionButton) {
    actionButton.textContent = unlocked ? 'Already Unlocked' : `Unlock Pack · ${item.price}`;
    actionButton.disabled = unlocked;
  }

  const list = getEl('storeModalCardsList');
  if (list) {
    list.replaceChildren();
    (expansionDecks[itemId] || []).forEach(card => {
      const wrapper = document.createElement('div');
      wrapper.style.background = '#1f122e';
      wrapper.style.border = '1px solid var(--border)';
      wrapper.style.borderRadius = '8px';
      wrapper.style.padding = '8px 10px';
      const meta = document.createElement('div');
      meta.style.cssText = 'font-size:0.65rem;color:var(--gold);font-weight:800;text-transform:uppercase;';
      meta.textContent = `${card.category} · ${card.location} · Budget: ${card.budget}`;
      const title = document.createElement('div');
      title.style.cssText = 'font-size:0.85rem;font-weight:900;color:var(--cream);';
      title.textContent = card.title;
      const detail = document.createElement('div');
      detail.style.cssText = 'font-size:0.75rem;color:var(--muted);';
      detail.textContent = card.detail;
      wrapper.append(meta, title, detail);
      list.appendChild(wrapper);
    });
  }
  const previewModal = getEl('storePreviewModal');
  if (previewModal) previewModal.classList.add('show');
}

function closeStorePreview() {
  const previewModal = getEl('storePreviewModal');
  if (previewModal) previewModal.classList.remove('show');
  selectedPreviewItemId = null;
}

async function actionFromPreviewModal() {
  if (!selectedPreviewItemId) return;
  const itemId = selectedPreviewItemId;
  closeStorePreview();
  await handleStoreAction(itemId);
}

/* Production Refactored Native Billing Framework via RevenueCat */
async function handleStoreAction(itemId) {
  if (unlockedItems.includes(itemId)) {
    showToast('This pack is already unlocked on this device.');
    return;
  }

  if (window.Capacitor && window.Capacitor.isNativePlatform() && Purchases) {
    try {
      showToast('Connecting to app store billing...');
      const offerings = await Purchases.getOfferings();
      if (offerings.current) {
        const pkg = offerings.current.availablePackages.find(
          p => p.product.identifier === `com.datenightdecider.${itemId.replace('-', '.')}`
        );
        if (pkg) {
          const { customerInfo } = await Purchases.purchasePackage({ package: pkg });
          if (customerInfo.entitlements.active[ENTITLEMENT_IDS.ALL_EXPANSIONS] || customerInfo.entitlements.active[itemId]) {
            await applySuccessfulUnlock(itemId);
            return;
          }
        }
      }
    } catch (err) {
      if (!err.userCancelled) {
        showToast(`Store transaction failed: ${err.message}`);
      }
      return;
    }
  } else {
    showConfirmModal('Unlock Expansion Pack', 'Proceed with unlocking pack "' + itemId + '" on this device?', 'Store Purchase', async () => {
      await applySuccessfulUnlock(itemId);
    });
  }
}

async function applySuccessfulUnlock(itemId) {
  const previousPacks = [...selectedPacks];
  try {
    if (!unlockedItems.includes(itemId)) unlockedItems.push(itemId);
    if (!selectedPacks.includes(itemId)) selectedPacks.push(itemId);
    if (!useMemoryFallback && db) {
      await db.unlocks.put({ id: itemId });
      await db.settings.put({ key: 'selectedPacks', value: selectedPacks });
    }
    await triggerHaptic('success');
    renderPackChoices();
    refreshDecks();
    initMatcher();
    renderLibrary();
    renderStore();
    showToast('Expansion pack unlocked successfully!');
  } catch (err) {
    unlockedItems = unlockedItems.filter(id => id !== itemId);
    selectedPacks = previousPacks;
    showToast('Could not save pack unlock state locally.');
  }
}

async function restorePurchases() {
  if (window.Capacitor && window.Capacitor.isNativePlatform() && Purchases) {
    try {
      showToast('Restoring transactions with store...');
      const customerInfo = await Purchases.restorePurchases();
      const activeEntitlements = customerInfo.entitlements.active;
      let restoredCount = 0;

      for (const pack of storeCatalog) {
        if ((activeEntitlements[pack.id]?.isActive || activeEntitlements[ENTITLEMENT_IDS.ALL_EXPANSIONS]?.isActive) && !unlockedItems.includes(pack.id)) {
          unlockedItems.push(pack.id);
          if (!selectedPacks.includes(pack.id)) selectedPacks.push(pack.id);
          restoredCount++;
        }
      }

      if (!useMemoryFallback && db) {
        await db.unlocks.clear();
        if (unlockedItems.length) {
          await db.unlocks.bulkPut(unlockedItems.map(id => ({ id })));
        }
        await db.settings.put({ key: 'selectedPacks', value: selectedPacks });
      }

      refreshDecks();
      renderStore();
      showToast(restoredCount > 0 ? `Restored ${restoredCount} expansion pack(s)!` : 'No previous purchases found.');
      return;
    } catch (err) {
      showToast(`Restore failed: ${err.message}`);
      return;
    }
  }
  showToast('Purchase restoration is managed automatically through store bindings.');
}

function renderTracker() {
  const label = getEl('dateGoalStatus');
  const bar = getEl('dateGoalBar');
  const progress = getEl('dateGoalProgress');
  if (!bar || !label) return;

  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);

  const count = dateHistory.filter(entry => new Date(entry.date) >= startOfWeek).length;
  const percent = Math.min(100, count * 100);
  label.textContent = `${count} / 1 Done`;
  bar.style.width = `${percent}%`;
  if (progress) progress.setAttribute('aria-valuenow', String(percent));
}

function renderAnalyticsDashboard() {
  const dashboard = getEl('analyticsDashboard');
  if (!dashboard) return;
  dashboard.replaceChildren();
  if (!dateHistory.length) return;
  const ratings = [];
  dateHistory.forEach(entry => [entry.rating1, entry.rating2].forEach(value => {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 1 && n <= 5) ratings.push(n);
  }));
  const average = ratings.length ? (ratings.reduce((sum, n) => sum + n, 0) / ratings.length).toFixed(1) : '—';
  const card = document.createElement('div');
  card.className = 'stats-card';
  const grid = document.createElement('div');
  grid.className = 'stats-grid';
  const completed = document.createElement('div');
  completed.className = 'stat-box';
  completed.innerHTML = `<div class="val">${dateHistory.length}</div><div class="lbl">Completed</div>`;
  const rating = document.createElement('div');
  rating.className = 'stat-box';
  rating.innerHTML = `<div class="val">${escapeHtml(average === '—' ? average : `⭐ ${average}`)}</div><div class="lbl">Average rating</div>`;
  grid.append(completed, rating);
  card.appendChild(grid);
  dashboard.appendChild(card);
}

function renderHistory() {
  renderAnalyticsDashboard();
  renderTracker();
  const list = getEl('historyList');
  const stats = getEl('historyStats');
  if (!list) return;
  if (stats) stats.textContent = `${dateHistory.length} completed dates in scrapbook`;
  list.replaceChildren();
  if (!dateHistory.length) {
    const empty = document.createElement('div');
    empty.className = 'library-summary';
    empty.textContent = 'No dates logged yet. Complete a date to build your scrapbook!';
    list.appendChild(empty);
    return;
  }
  dateHistory.forEach(entry => {
    const row = document.createElement('article');
    row.className = 'library-item';
    const category = document.createElement('div');
    category.className = 'library-category';
    const date = new Date(entry.date);
    category.textContent = `${entry.category || 'Date'} · ${Number.isNaN(date.getTime()) ? 'Date unknown' : date.toLocaleDateString()}`;
    const title = document.createElement('div');
    title.className = 'library-title';
    title.textContent = entry.title || 'Untitled date';
    const detail = document.createElement('div');
    detail.className = 'library-detail';
    const ratingText = entry.rating1 || entry.rating2 ? `Ratings: ${entry.rating1 ?? '—'}/5 & ${entry.rating2 ?? '—'}/5` : '';
    detail.textContent = [entry.note || entry.detail || '', ratingText].filter(Boolean).join(' · ');
    row.append(category, title, detail);
    list.appendChild(row);
  });
}

async function persistHistoryEntry(entry, broadcast = false) {
  const normalized = sanitizeHistoryEntry(entry);
  if (!normalized) return null;

  const syncId = normalized.syncId;
  const existing = dateHistory.find(record => record.syncId === syncId);
  if (existing) return existing;

  let saved = normalized;

  if (!useMemoryFallback && db) {
    try {
      const insertedId = await db.history.add(normalized);
      saved = await db.history.get(insertedId) || normalized;
    } catch (err) {
      console.warn('Could not persist to IndexedDB; keeping this entry in memory:', err);
      useMemoryFallback = true;
    }
  }

  dateHistory = [saved, ...dateHistory.filter(item => item.syncId !== saved.syncId)]
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  renderHistory();

  if (broadcast && remoteRoomId && myPlayerNum === 1) {
    sendP2PMessage({ type: 'HISTORY_ENTRY', entry: saved });
  }

  return saved;
}

async function receiveHistoryEntry(entry) {
  const normalized = sanitizeHistoryEntry(entry);
  if (!normalized) return null;
  if (dateHistory.some(record => record.syncId === normalized.syncId)) return null;
  return persistHistoryEntry(normalized, false);
}

async function applyTheme(theme) {
  appSettings.theme = ['dark', 'ocean'].includes(theme) ? theme : 'dark';
  document.documentElement.dataset.theme = appSettings.theme === 'dark' ? '' : appSettings.theme;
  const select = getEl('themeSelect');
  if (select) select.value = appSettings.theme;
  if (!useMemoryFallback && db) {
    try { await db.settings.put({ key: 'appSettings', value: appSettings }); }
    catch (err) { console.error('Could not save theme:', err); }
  }
}

async function saveFeedbackSettings(value) {
  appSettings.feedback = ['both', 'sound', 'vibration', 'off'].includes(value) ? value : 'both';
  if (!useMemoryFallback && db) {
    try { await db.settings.put({ key: 'appSettings', value: appSettings }); }
    catch (err) { console.error('Could not save feedback preference:', err); }
  }
}

function shareCurrentDate() {
  const item = window.currentWinner;
  if (!item) { showToast('Choose a date idea first.'); return; }
  const text = `💞 Date Night Decider: ${item.title}\n${item.detail}`;
  if (navigator.share) {
    navigator.share({ title: item.title, text }).catch(() => {});
  } else if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text)
      .then(() => showToast('Date idea copied to clipboard!'))
      .catch(() => showToast('Shared: ' + item.title));
  } else {
    showToast('Shared: ' + item.title);
  }
}

function openCurrentCardMap() {
  const item = window.currentWinner;
  if (!item) return;
  if (item.location !== 'out') {
    showToast('This is an at-home date; no map is needed. Check the date instructions.');
    return;
  }
  const query = `${item.title} near me`;
  window.open(
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`,
    '_blank',
    'noopener,noreferrer'
  );
}

function startSelectedDate() {
  const item = window.currentWinner;
  if (!item) return;
  showToast(`Starting date: ${item.title}! Have a wonderful time.`);
  if (item.location === 'out') {
    openCurrentCardMap();
  } else {
    showToast('At-home date selected—no map will be opened.');
  }
}

async function exportBackup() {
  const data = {
    version: '3.1.2',
    customDeck,
    deletedBuiltins: [...deletedBuiltins],
    dateHistory,
    settings: appSettings,
    unlockedItems,
    selectedPacks: [...selectedPacks],
    selectedCategories: [...document.querySelectorAll('.category-choice:checked')].map(input => input.value)
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'date-night-backup.json';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importBackupFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();

  reader.onload = async () => {
    try {
      const data = JSON.parse(String(reader.result || ''));
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Backup must be a JSON object.');
      }
      if (!data.version || !Array.isArray(data.dateHistory)) {
        throw new Error('Invalid backup file structure.');
      }

      const importedSettings = {
        theme: ['dark', 'ocean'].includes(data.settings?.theme) ? data.settings.theme : appSettings.theme,
        feedback: ['both', 'sound', 'vibration', 'off'].includes(data.settings?.feedback) ? data.settings.feedback : appSettings.feedback
      };

      const importedCustomDeck = sanitizeCardDeck(
        Array.isArray(data.customDeck) ? data.customDeck : customDeck
      );

      const importedHistory = data.dateHistory
        .slice(0, 5000)
        .map(sanitizeHistoryEntry)
        .filter(Boolean)
        .sort((a, b) => new Date(b.date) - new Date(a.date));

      const importedUnlocks = [...new Set(
        (Array.isArray(data.unlockedItems) ? data.unlockedItems : unlockedItems)
          .filter(id => typeof id === 'string' && expansionDecks[id])
      )];

      const importedPacks = [...new Set(
        (Array.isArray(data.selectedPacks) ? data.selectedPacks : ['starter', ...importedUnlocks])
          .filter(id => id === 'starter' || importedUnlocks.includes(id))
      )];

      const knownCardIds = new Set([
        ...masterDeck,
        ...Object.values(expansionDecks).flat()
      ].map(card => card.id));

      const importedDeleted = [...new Set(
        (Array.isArray(data.deletedBuiltins) ? data.deletedBuiltins : [...deletedBuiltins])
          .filter(id => typeof id === 'string' && knownCardIds.has(id))
      )];

      const importedCategories = [...new Set(
        (Array.isArray(data.selectedCategories) ? data.selectedCategories : selectedCategories)
          .filter(value => typeof value === 'string' && DEFAULT_CATEGORIES.includes(value))
      )];

      if (!useMemoryFallback && db) {
        await db.transaction(
          'rw',
          db.settings,
          db.customDeck,
          db.deletedBuiltins,
          db.categories,
          db.history,
          db.unlocks,
          async () => {
            await db.settings.clear();
            await db.settings.put({ key: 'appSettings', value: importedSettings });
            await db.settings.put({ key: 'selectedPacks', value: importedPacks });

            await db.customDeck.clear();
            if (importedCustomDeck.length) {
              await db.customDeck.bulkAdd(importedCustomDeck.map(item => ({ item })));
            }

            await db.deletedBuiltins.clear();
            if (importedDeleted.length) {
              await db.deletedBuiltins.bulkPut(importedDeleted.map(id => ({ id })));
            }

            await db.categories.clear();
            await db.categories.put({ id: 'selectedCats', values: importedCategories });

            await db.history.clear();
            if (importedHistory.length) {
              await db.history.bulkAdd(importedHistory);
            }

            await db.unlocks.clear();
            if (importedUnlocks.length) {
              await db.unlocks.bulkPut(importedUnlocks.map(id => ({ id })));
            }
          }
        );
      }

      appSettings = importedSettings;
      customDeck = importedCustomDeck;
      dateHistory = importedHistory;
      unlockedItems = importedUnlocks;
      selectedPacks = importedPacks;
      deletedBuiltins = new Set(importedDeleted);
      selectedCategories = importedCategories;

      document.querySelectorAll('.category-choice').forEach(input => {
        input.checked = selectedCategories.includes(input.value);
      });

      const budgetFilter = getEl('budgetFilter');
      if (budgetFilter && !['all', 'free', 'paid'].includes(budgetFilter.value)) {
        budgetFilter.value = 'all';
      }

      renderPackChoices();
      refreshDecks();
      await applyTheme(appSettings.theme || 'dark');
      initMatcher();
      renderHistory();
      renderStore();
      renderLibrary();
      showToast('Backup restored successfully.');
    } catch (error) {
      console.error('Backup import failed:', error);
      showToast('Backup was not restored. It may be invalid or storage may be unavailable.');
    } finally {
      event.target.value = '';
    }
  };

  reader.readAsText(file);
}

/* Guideline 5.1.1 Compliance: Clear User Data API */
async function clearAllData() {
  showConfirmModal('Clear Application Data?', 'Are you sure you want to clear all history, ratings, custom cards, and unlocked settings? This cannot be undone.', 'Danger Zone', async () => { executeClearAllData(); });
}

async function executeClearAllData() {

  try {
    if (!useMemoryFallback && db) {
      await db.settings.clear();
      await db.customDeck.clear();
      await db.deletedBuiltins.clear();
      await db.categories.clear();
      await db.history.clear();
      await db.unlocks.clear();
    }
    customDeck = [];
    deletedBuiltins = new Set();
    unlockedItems = [];
    dateHistory = [];
    selectedPacks = ['starter'];
    selectedCategories = [...DEFAULT_CATEGORIES];

    renderPackChoices();
    refreshDecks();
    initMatcher();
    renderHistory();
    renderStore();
    renderLibrary();
    showToast('All local data cleared successfully.');
  } catch (err) {
    showToast('Failed to clear local application storage.');
  }
}

function triggerConfetti() {
  const canvas = getEl('confettiCanvas');
  if (!canvas) return;
  const context = canvas.getContext('2d');
  if (!context) return;
  const width = window.innerWidth;
  const height = window.innerHeight;
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const particles = Array.from({ length: 50 }, () => ({
    x: width / 2, y: height / 2,
    vx: (Math.random() - 0.5) * 10,
    vy: (Math.random() - 0.5) * 10 - 2,
    color: ['#ff3b6c', '#f6c941', '#ffffff'][Math.floor(Math.random() * 3)],
    size: Math.random() * 5 + 3, life: 80
  }));
  function render() {
    context.clearRect(0, 0, width, height);
    let alive = false;
    particles.forEach(particle => {
      if (particle.life <= 0) return;
      particle.x += particle.vx;
      particle.y += particle.vy;
      particle.vy += 0.2;
      particle.life -= 1;
      alive = true;
      context.fillStyle = particle.color;
      context.fillRect(particle.x, particle.y, particle.size, particle.size);
    });
    if (alive) requestAnimationFrame(render);
    else context.clearRect(0, 0, width, height);
  }
  render();
}

function showModal(eyebrow, title, detail) {
  playSound('win');
  triggerHaptic('success');
  triggerConfetti();

  const ebEl = getEl('modalEyebrow'); if (ebEl) ebEl.textContent = eyebrow;
  const nameEl = getEl('modalIdeaName'); if (nameEl) nameEl.textContent = title || 'Date Idea';

  const winner = window.currentWinner;
  const detailEl = getEl('modalIdeaDetail');
  if (!detailEl) return;

  if (winner && (winner.mission || winner.howToPlay)) {
    let html = `<p style="margin-bottom:12px;font-weight:600;color:var(--cream);">${escapeHtml(winner.mission || detail)}</p>`;

    if (winner.duration || winner.costEstimate || winner.equipment) {
      html += `<div style="background:rgba(255,255,255,0.05);padding:10px;border-radius:10px;margin-bottom:12px;text-align:left;font-size:0.78rem;">`;
      if (winner.duration) html += `<div>⏱ <strong>Duration:</strong> ${escapeHtml(winner.duration)}</div>`;
      if (winner.costEstimate) html += `<div>💵 <strong>Estimated Cost:</strong> ${escapeHtml(winner.costEstimate)}</div>`;
      if (winner.equipment) html += `<div>🧰 <strong>Needs:</strong> ${escapeHtml(Array.isArray(winner.equipment) ? winner.equipment.join(', ') : winner.equipment)}</div>`;
      html += `</div>`;
    }

    if (Array.isArray(winner.howToPlay) && winner.howToPlay.length) {
      html += `<div style="text-align:left;margin-bottom:12px;"><strong style="color:var(--gold);font-size:0.8rem;text-transform:uppercase;">🎮 Instructions</strong><ol style="margin-left:18px;font-size:0.78rem;color:var(--muted);margin-top:4px;">`;
      winner.howToPlay.forEach(step => { html += `<li>${escapeHtml(step)}</li>`; });
      html += `</ol></div>`;
    }

    if (winner.importantRule) {
      html += `<div style="text-align:left;font-size:0.75rem;color:#f87171;"><strong style="color:#ef4444;">❤️ Important Rule:</strong> ${escapeHtml(winner.importantRule)}</div>`;
    }

    detailEl.innerHTML = html;
  } else {
    detailEl.textContent = detail || '';
  }

  const mapButton = getEl('mapDirectionsBtn');
  if (mapButton) mapButton.style.display = winner && winner.location === 'out' ? 'block' : 'none';

  const completeButton = getEl('completeDateBtn');
  if (completeButton) completeButton.disabled = !winner;

  const decisionModal = getEl('decisionModal');
  if (decisionModal) decisionModal.classList.add('show');
}

function resetRemoteRound() {
  p1Deck = shuffle(activeDeck);
  p2Deck = [...p1Deck];
  p1Likes = [];
  p2Likes = [];
  swipeIndex = 0;
  swipePlayer = 1;
  remoteSubmitSent = false;
  remotePartnerLikes = null;
  remoteMatchResolved = false;
  window.currentWinner = null;
  draftItems = [];
  draftTurn = 1;
  updateSwipeCard();
}

function closeModal() {
  const decisionModal = getEl('decisionModal');
  if (decisionModal) decisionModal.classList.remove('show');
  if (remoteRoomId) {
    if (myPlayerNum === 1) {
      window.currentWinner = null;
      resetRemoteRound();
      sendRoomState();
      if (conn && conn.open) {
        sendP2PMessage({ type: 'NEW_ROUND' });
      }
    }
  } else {
    initMatcher();
  }
}

function validRating(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

async function completeCurrentDate() {
  const item = window.currentWinner;
  if (!item) { closeModal(); return; }
  
  p1Rating = 5;
  p2Rating = 5;
  setRating(1, 5);
  setRating(2, 5);
  
  const noteInput = getEl('logDateNoteInput');
  if (noteInput) noteInput.value = '';
  
  const titleEl = getEl('logDateItemTitle');
  if (titleEl) titleEl.textContent = item.title || 'Untitled date';
  
  const modal = getEl('logDateModal');
  if (modal) modal.classList.add('show');
}

function downloadCalendarEvent() {
  const item = window.currentWinner;
  if (!item) { showToast('Choose a date idea first.'); return; }

  const dateInput = getEl('calendarDateInput');
  if (dateInput) {
    const today = new Date();
    const defaultDateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    dateInput.value = defaultDateStr;
  }
  const modal = getEl('calendarModal');
  if (modal) modal.classList.add('show');
}

function normalizeRoomCode(raw) {
  return String(raw || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 64);
}

function generateRoomCode() {
  try {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  } catch (_) {
    return createUniqueId().replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 32);
  }
}

function roomPeerId(code) {
  return `datenight-${code}`;
}

function copyInviteLink() {
  if (!remoteRoomId || myPlayerNum !== 1 || !peer || !peer.open) {
    showToast('Start a live room and wait until the room is ready before copying its invite link.');
    return;
  }

  const invite = new URL(window.location.pathname, window.location.origin);
  invite.searchParams.set('room', remoteRoomId);
  const link = invite.href;

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(link)
      .then(() => showToast('Invite link copied to clipboard!'))
      .catch(() => showToast('Link ready: ' + link));
  } else {
    showToast('Link ready: ' + link);
  }
}

async function startP2PServer(presetCode = null) {
  if (!presetCode) {
    openLiveRoomModal('host');
    return;
  }
  const raw = presetCode;
  if (!raw) return;
  const code = normalizeRoomCode(raw);
  if (code.length < 12) {
    showToast('Use a room code at least 12 characters long.');
    return;
  }

  if (typeof window.Peer !== 'function') { showToast('PeerJS did not load. Check your connection and reload.'); return; }
  
  // Securely fetch dynamic ephemeral ICE servers before starting PeerJS session
  const dynamicIceServers = await fetchEphemeralIceServers();
  PEER_OPTIONS.config.iceServers = dynamicIceServers;

  cleanupPeerConnection();
  remoteRoomId = code;
  myPlayerNum = 1;
  currentRoomPeerId = roomPeerId(code);
  connectionState = 'creating';
  resetRemoteRound();
  try {
    peer = new Peer(currentRoomPeerId, PEER_OPTIONS);

    peer.on('disconnected', () => {
      connectionState = 'disconnected';
      try { peer.reconnect(); } catch (_) {}
    });

    peer.on('open', () => {
      connectionState = 'waiting';
      showToast(`Room “${code}” is ready as Player 1. Share your invite link!`);
      updateConnectionBanner();
    });
    
    peer.on('connection', incoming => {
      if (conn && conn.open) {
        incoming.close();
        showToast('A partner is already connected to this room.');
        return;
      }
      connectionState = 'connecting';
      conn = incoming;
      setupConnectionHandlers(conn);
      conn.on('open', () => {
        connectionState = 'connected';
        sendRoomState();
        startHeartbeat();
        showToast('Partner connected. The live room is synchronized.');
        updateSwipeCard();
      });
    });

    peer.on('error', error => {
      connectionState = 'disconnected';
      if (error.type === 'network' || error.type === 'socket-closed') {
        try { peer.reconnect(); } catch (_) {}
      } else if (error.type === 'unavailable-id') {
        showToast('That room code is already in use. Choose a different code.');
      } else {
        showToast(`Room error: ${error.type || 'Connection failed'}`);
      }
      updateConnectionBanner();
    });
  } catch (error) {
    connectionState = 'disconnected';
    cleanupPeerConnection();
    showToast('Could not start live room.');
  }
}

async function joinP2PServer(presetCode = null) {
  if (!presetCode) {
    openLiveRoomModal('join');
    return;
  }
  const raw = presetCode;
  if (!raw) return;
  const code = normalizeRoomCode(raw);
  if (code.length < 12) {
    showToast('Enter a room code at least 12 characters long.');
    return;
  }

  if (typeof window.Peer !== 'function') { showToast('PeerJS did not load. Check your connection and reload.'); return; }

  // Securely fetch dynamic ephemeral ICE servers before joining PeerJS session
  const dynamicIceServers = await fetchEphemeralIceServers();
  PEER_OPTIONS.config.iceServers = dynamicIceServers;

  cleanupPeerConnection();
  remoteRoomId = code;
  myPlayerNum = 2;
  currentRoomPeerId = roomPeerId(code);
  connectionState = 'connecting';
  try {
    peer = new Peer(PEER_OPTIONS);

    peer.on('disconnected', () => {
      connectionState = 'disconnected';
      try { peer.reconnect(); } catch (_) {}
    });

    peer.on('open', () => {
      conn = peer.connect(currentRoomPeerId, { reliable: true });
      setupConnectionHandlers(conn);
      conn.on('open', () => {
        connectionState = 'connected';
        showToast(`Connected to room “${code}” as Player 2. Waiting for host's shared deck…`);
        startHeartbeat();
        updateSwipeCard();
      });
    });

    peer.on('error', error => {
      connectionState = 'disconnected';
      if (error.type === 'network' || error.type === 'socket-closed') {
        try { peer.reconnect(); } catch (_) {}
      } else {
        showToast(`Join error: ${error.type || 'Could not connect'}`);
      }
      updateConnectionBanner();
    });
  } catch (error) {
    connectionState = 'disconnected';
    cleanupPeerConnection();
    showToast('Could not join live room.');
  }
}

function startHeartbeat() {
  if (p2HeartbeatTimer) window.clearInterval(p2HeartbeatTimer);
  p2HeartbeatTimer = window.setInterval(() => {
    if (conn && conn.open) {
      sendP2PMessage({ type: 'PING', timestamp: Date.now() });
    }
  }, 10000);
}

function leaveLiveRoom() {
  if (!remoteRoomId) {
    showToast('You are not currently in a live room.');
    return;
  }
  showConfirmModal('Leave Live Room?', 'Are you sure you want to leave the live couple room and return to local play mode?', 'Live Sync', () => {
    cleanupPeerConnection();
    refreshDecks();
    initMatcher();
    showToast('Returned to local play mode.');
  });
}

function cleanupPeerConnection() {
  if (p2HeartbeatTimer) {
    window.clearInterval(p2HeartbeatTimer);
    p2HeartbeatTimer = null;
  }
  try { if (conn) conn.close(); } catch (_) {}
  try { if (peer) peer.destroy(); } catch (_) {}
  conn = null;
  peer = null;
  remoteRoomId = null;
  currentRoomPeerId = null;
  myPlayerNum = 1;
  remoteSubmitSent = false;
  remotePartnerLikes = null;
  remoteMatchResolved = false;
  connectionState = 'disconnected';
  guestRoundId = null;
  pendingCompleteEntry = null;

  const completeButton = getEl('completeDateBtn');
  if (completeButton) completeButton.disabled = !window.currentWinner;

  updateSwipeCard();
}

function sendP2PMessage(payload) {
  if (!conn || !conn.open) return false;
  try { conn.send(payload); return true; }
  catch (error) { console.error('Could not send live-room message:', error); return false; }
}

function sendRoomState() {
  if (!remoteRoomId || myPlayerNum !== 1 || !conn || !conn.open) return;

  const budgetFilterEl = getEl('budgetFilter');
  sendP2PMessage({
    type: 'SYNC_STATE',
    matcherDeck: p1Deck,
    hostFilters: {
      categories: [...document.querySelectorAll('.category-choice:checked')].map(input => input.value),
      packs: [...selectedPacks],
      budget: budgetFilterEl ? budgetFilterEl.value : 'all'
    }
  });
}

function tryResolveRemoteMatch() {
  if (!remoteRoomId || myPlayerNum !== 1) return false;
  if (remoteMatchResolved) return false;
  if (!Array.isArray(remotePartnerLikes)) return false;
  if (swipeIndex < p1Deck.length) return false;

  const partnerLikeIds = new Set(remotePartnerLikes.filter(item => item && item.id).map(item => item.id));
  const mutual = p1Likes.filter(item => partnerLikeIds.has(item.id));

  remoteMatchResolved = true;
  handleMatchOutcome(mutual);
  return true;
}

function setupConnectionHandlers(thisConn) {
  if (!thisConn) return;

  thisConn.on('data', message => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'PING') return;

    if (message.type === 'SYNC_STATE' && myPlayerNum === 2) {
      if (!Array.isArray(message.matcherDeck)) return;

      const sharedDeck = sanitizeCardDeck(message.matcherDeck);
      p1Deck = [...sharedDeck];
      p2Deck = [...sharedDeck];

      p1Likes = [];
      p2Likes = [];
      swipeIndex = 0;
      swipePlayer = 1;
      remoteSubmitSent = false;
      remotePartnerLikes = null;
      remoteMatchResolved = false;
      window.currentWinner = null;
      draftItems = [];

      const decisionModal = getEl('decisionModal');
      const votingModal = getEl('votingModal');
      if (decisionModal) decisionModal.classList.remove('show');
      if (votingModal) votingModal.classList.remove('show');

      if (message.hostFilters && typeof message.hostFilters === 'object') {
        const hostFilters = message.hostFilters;
        if (Array.isArray(hostFilters.categories)) {
          const categorySet = new Set(
            hostFilters.categories.filter(value => DEFAULT_CATEGORIES.includes(value))
          );
          document.querySelectorAll('.category-choice').forEach(input => {
            input.checked = categorySet.has(input.value);
          });
        }
        if (Array.isArray(hostFilters.packs)) {
          selectedPacks = [...new Set(hostFilters.packs.filter(value =>
            value === 'starter' || Object.prototype.hasOwnProperty.call(expansionDecks, value)
          ))];
          renderPackChoices();
        }
        if (['all', 'free', 'paid'].includes(hostFilters.budget)) {
          const budgetEl = getEl('budgetFilter');
          if (budgetEl) budgetEl.value = hostFilters.budget;
        }
      }

      updateSwipeCard();
      return;
    }

    if (message.type === 'NEW_ROUND' && myPlayerNum === 2) {
      const decisionModal = getEl('decisionModal');
      const votingModal = getEl('votingModal');
      if (decisionModal) decisionModal.classList.remove('show');
      if (votingModal) votingModal.classList.remove('show');
      window.currentWinner = null;
      remoteSubmitSent = false;
      return;
    }

    if (message.type === 'SUBMIT_SWIPES' && myPlayerNum === 1) {
      remotePartnerLikes = sanitizeCardDeck(message.likedCards);
      tryResolveRemoteMatch();
      updateSwipeCard();
      return;
    }

    if (message.type === 'MATCH_WINNER' && myPlayerNum === 2) {
      const winnerId = limitText(message.winnerId, 80);
      const winner = p2Deck.find(item => item.id === winnerId) || fullDeck.find(item => item.id === winnerId);
      if (winner) {
        const votingModal = getEl('votingModal');
        if (votingModal) votingModal.classList.remove('show');
        window.currentWinner = winner;
        showModal('It’s a Match!', winner.title, winner.detail);
      }
      return;
    }

    if (message.type === 'NO_MUTUAL_MATCHES' && myPlayerNum === 2) {
      showNoMutualMatches();
      return;
    }

    if (message.type === 'REQUEST_NEW_ROUND' && myPlayerNum === 1) {
      restartMatcherAfterNoMatch();
      return;
    }

    if (message.type === 'REQUEST_FILTER_CHANGE' && myPlayerNum === 1) {
      const votingModal = getEl('votingModal');
      if (votingModal) votingModal.classList.remove('show');
      const actions = getEl('noMatchesActions');
      if (actions) actions.hidden = true;
      const picker = getEl('categoryPicker');
      if (picker) picker.open = true;
      const summary = getEl('categorySummary');
      if (summary) summary.focus();
      showToast('Your partner requested a pack/category change. Adjust filters to restart the round.');
      return;
    }

    if (message.type === 'MUTUAL_DRAFT_START' && myPlayerNum === 2) {
      draftItems = sanitizeCardDeck(message.draftItems).map(item => ({
        ...item,
        banned: item.banned === true
      }));
      draftTurn = Number(message.draftTurn) === 2 ? 2 : 1;
      const actions = getEl('noMatchesActions');
      if (actions) actions.hidden = true;
      const eyebrow = getEl('votingEyebrow');
      const title = getEl('votingModalTitle');
      if (eyebrow) eyebrow.textContent = 'Mutual Match Draft';
      if (title) title.textContent = 'Take Turns Eliminating';
      renderDraftGrid();
      const modal = getEl('votingModal');
      if (modal) modal.classList.add('show');
      return;
    }

    if (message.type === 'BAN_REQUEST' && myPlayerNum === 1) {
      if (draftTurn === 2 && Number.isInteger(message.index)) executeBan(message.index);
      return;
    }

    if (message.type === 'DRAFT_STATE' && myPlayerNum === 2) {
      draftItems = sanitizeCardDeck(message.draftItems).map(item => ({
        ...item,
        banned: item.banned === true
      }));
      draftTurn = Number(message.draftTurn) === 2 ? 2 : 1;
      renderDraftGrid();
      const remaining = draftItems.filter(item => !item.banned);
      if (remaining.length === 1) {
        window.currentWinner = remaining[0];
        const votingModal = getEl('votingModal');
        if (votingModal) votingModal.classList.remove('show');
        showModal('Winner by Elimination!', remaining[0].title, remaining[0].detail);
      }
      return;
    }

    if (message.type === 'COMPLETE_DATE_REQUEST' && myPlayerNum === 1) {
      const incomingEntry = sanitizeHistoryEntry(message.entry);
      if (!incomingEntry) {
        sendP2PMessage({
          type: 'COMPLETE_DATE_ACK',
          syncId: limitText(message.entry?.syncId, 120),
          ok: false
        });
        return;
      }

      const alreadySaved = dateHistory.some(record => record.syncId === incomingEntry.syncId);
      if (alreadySaved) {
        sendP2PMessage({ type: 'COMPLETE_DATE_ACK', syncId: incomingEntry.syncId, ok: true });
        return;
      }

      persistHistoryEntry(incomingEntry, true)
        .then(saved => {
          const ok = Boolean(saved);
          sendP2PMessage({ type: 'COMPLETE_DATE_ACK', syncId: incomingEntry.syncId, ok });
          if (ok) closeModal();
        })
        .catch(error => {
          console.error('Could not save partner-completed date:', error);
          sendP2PMessage({ type: 'COMPLETE_DATE_ACK', syncId: incomingEntry.syncId, ok: false });
        });

      return;
    }

    if (message.type === 'COMPLETE_DATE_ACK' && myPlayerNum === 2) {
      if (!pendingCompleteEntry || message.syncId !== pendingCompleteEntry.syncId) return;

      const entry = pendingCompleteEntry;
      pendingCompleteEntry = null;

      const completeButton = getEl('completeDateBtn');
      if (completeButton) completeButton.disabled = !window.currentWinner;

      if (message.ok === true) {
        persistHistoryEntry(entry, false)
          .then(() => {
            closeModal();
            showToast('Date completion confirmed and saved.');
          })
          .catch(error => {
            console.error('Could not save the confirmed date locally:', error);
          });
      } else {
        showToast('The host could not confirm the save.');
      }

      return;
    }

    if (message.type === 'HISTORY_ENTRY' && myPlayerNum === 2 && message.entry) {
      receiveHistoryEntry(message.entry).catch(error => console.error('Could not receive history entry:', error));
    }
  });

  thisConn.on('open', () => {
    conn = thisConn;
    connectionState = 'connected';
    if (myPlayerNum === 2 && pendingCompleteEntry) {
      sendP2PMessage({ type: 'COMPLETE_DATE_REQUEST', entry: pendingCompleteEntry });
    }
    updateSwipeCard();
  });

  thisConn.on('close', () => {
    if (thisConn !== conn) return;
    conn = null;
    connectionState = 'disconnected';
    remoteSubmitSent = false;
    updateSwipeCard();

    if (remoteRoomId && myPlayerNum === 2) {
      showToast('Connection lost. Reconnecting to host...');
      window.setTimeout(() => {
        if (!remoteRoomId || myPlayerNum !== 2) return;
        if (peer && !peer.destroyed) {
          const newConn = peer.connect(currentRoomPeerId, { reliable: true });
          setupConnectionHandlers(newConn);
          newConn.on('open', () => {
            connectionState = 'connected';
            showToast('Reconnected to live room host!');
            startHeartbeat();
          });
        }
      }, 3000);
    }
  });
}

async function loadAppData() {
  try {
    if (!useMemoryFallback && db) {
      const settingsRecord = await db.settings.get('appSettings');
      if (settingsRecord?.value && typeof settingsRecord.value === 'object') {
        appSettings = {
          theme: ['dark', 'ocean'].includes(settingsRecord.value.theme) ? settingsRecord.value.theme : 'dark',
          feedback: ['both', 'sound', 'vibration', 'off'].includes(settingsRecord.value.feedback) ? settingsRecord.value.feedback : 'both'
        };
      }

      const customRecords = await db.customDeck.toArray();
      customDeck = sanitizeCardDeck(customRecords.map(record => record.item));
      const deletedRecords = await db.deletedBuiltins.toArray();
      deletedBuiltins = new Set(deletedRecords.map(record => record.id));
      dateHistory = (await db.history.orderBy('date').reverse().toArray())
        .map(sanitizeHistoryEntry)
        .filter(Boolean);
      const unlockRecords = await db.unlocks.toArray();
      unlockedItems = unlockRecords.map(record => record.id).filter(id => expansionDecks[id]);
      const selectedPacksRecord = await db.settings.get('selectedPacks');
      selectedPacks = Array.isArray(selectedPacksRecord?.value)
        ? [...new Set(selectedPacksRecord.value.filter(id => id === 'starter' || unlockedItems.includes(id)))]
        : ['starter', ...unlockedItems];

      const categoryRecord = await db.categories.get('selectedCats');
      selectedCategories = Array.isArray(categoryRecord?.values)
        ? categoryRecord.values.filter(value => DEFAULT_CATEGORIES.includes(value))
        : [...DEFAULT_CATEGORIES];
    }
  } catch (error) {
    console.warn('Some saved data could not be loaded from IndexedDB; using defaults:', error);
  }

  document.querySelectorAll('.category-choice').forEach(input => {
    input.checked = selectedCategories.includes(input.value);
  });
  const feedbackSelect = getEl('feedbackSelect');
  if (feedbackSelect) feedbackSelect.value = appSettings.feedback;
  
  renderPackChoices();
  refreshDecks();
  initMatcher();
  renderLibrary();
  renderHistory();
  renderStore();
  await applyTheme(appSettings.theme || 'dark');

  /* Native Boot Optimization: Hide Splash Screen after initial load */
  if (window.Capacitor && window.Capacitor.isPluginAvailable('SplashScreen')) {
    try {
      await window.Capacitor.Plugins.SplashScreen.hide();
    } catch (_) {}
  }

  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get('room');
  if (roomParam) {
    window.setTimeout(() => {
      const code = normalizeRoomCode(roomParam);
      if (code) {
        joinP2PServer(code);
      }
    }, 500);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  installSwipeGestures();

  const swipeCard = getEl('swipeCard');
  swipeCard?.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      handleSwipe(false);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      handleSwipe(true);
    }
  });

  const categoryPicker = getEl('categoryPicker');
  const categorySummary = getEl('categorySummary');
  if (categoryPicker && categorySummary) {
    const syncExpandedState = () => {
      categorySummary.setAttribute('aria-expanded', String(categoryPicker.open));
    };
    categoryPicker.addEventListener('toggle', syncExpandedState);
    syncExpandedState();
  }

  loadAppData().catch(error => {
    console.error('App initialization failed:', error);
  });
});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(error => console.warn('Service worker registration failed:', error));
  });
}


/* Custom In-App Modal System for Ratings, Calendar, Live Room, Legal, and Confirmations */

let p1Rating = 5, p2Rating = 5;

function setRating(player, val) {
  if (player === 1) {
    p1Rating = val;
    const label = getEl('p1RatingVal'); if (label) label.textContent = String(val);
    const container = getEl('p1StarRating');
    if (container) {
      container.querySelectorAll('.star-btn').forEach((btn, idx) => {
        btn.classList.toggle('active', idx < val);
      });
    }
  } else if (player === 2) {
    p2Rating = val;
    const label = getEl('p2RatingVal'); if (label) label.textContent = String(val);
    const container = getEl('p2StarRating');
    if (container) {
      container.querySelectorAll('.star-btn').forEach((btn, idx) => {
        btn.classList.toggle('active', idx < val);
      });
    }
  }
}

function closeLogDateModal() {
  const modal = getEl('logDateModal');
  if (modal) modal.classList.remove('show');
}

async function saveLoggedDate() {
  const item = window.currentWinner;
  if (!item) { closeLogDateModal(); return; }
  
  const noteInput = getEl('logDateNoteInput');
  const note = noteInput ? limitText(noteInput.value, 2000) : '';
  
  const entry = sanitizeHistoryEntry({
    syncId: createUniqueId(),
    cardId: item.id || null,
    title: item.title || 'Untitled date',
    category: item.category || 'Date',
    detail: item.detail || '',
    date: new Date().toISOString(),
    rating1: p1Rating,
    rating2: p2Rating,
    note
  });

  if (!entry) {
    showToast('This date entry could not be validated.');
    return;
  }

  closeLogDateModal();

  try {
    if (remoteRoomId && myPlayerNum === 2) {
      if (!conn || !conn.open) {
        await persistHistoryEntry(entry, false);
        closeModal();
        showToast('Saved on this device only (offline).');
        return;
      }
      pendingCompleteEntry = entry;
      const sent = sendP2PMessage({ type: 'COMPLETE_DATE_REQUEST', entry });
      if (!sent) {
        pendingCompleteEntry = null;
        await persistHistoryEntry(entry, false);
        closeModal();
        showToast('Saved on this device only.');
        return;
      }
      const completeButton = getEl('completeDateBtn');
      if (completeButton) completeButton.disabled = true;
      showToast('Waiting for host confirmation...');
      return;
    }

    await persistHistoryEntry(entry, true);
    closeModal();
    showToast('Date saved to scrapbook! ⭐');
  } catch (error) {
    console.error('Could not save completed date:', error);
    showToast('The date could not be saved. Please try again.');
  }
}

function closeCalendarModal() {
  const modal = getEl('calendarModal');
  if (modal) modal.classList.remove('show');
}

function generateAndDownloadCalendar() {
  const item = window.currentWinner;
  if (!item) { closeCalendarModal(); return; }

  const dateInput = getEl('calendarDateInput');
  const timeInput = getEl('calendarTimeInput');
  const userDate = dateInput ? dateInput.value : '';
  const userTime = timeInput ? timeInput.value : '19:00';

  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(userDate);
  const timeMatch = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(userTime);

  if (!dateMatch || !timeMatch) {
    showToast('Select a valid date and start time.');
    return;
  }

  const start = new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]), Number(timeMatch[1]), Number(timeMatch[2]));
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
  const formatUtc = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const icsEscape = val => String(val || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');

  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Date Night Decider//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT', `UID:${createUniqueId()}@datenightdecider`, `DTSTAMP:${formatUtc(new Date())}`,
    `SUMMARY:${icsEscape(`Date: ${item.title}`)}`, `DESCRIPTION:${icsEscape(item.detail)}`,
    `DTSTART:${formatUtc(start)}`, `DTEND:${formatUtc(end)}`, 'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n');

  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'date-night.ics';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  closeCalendarModal();
  showToast('Calendar event downloaded!');
}

function openLiveRoomModal(initialTab = 'host') {
  switchLiveRoomTab(initialTab);
  if (initialTab === 'host') {
    generateNewHostCode();
  }
  const modal = getEl('liveRoomModal');
  if (modal) modal.classList.add('show');
}

function closeLiveRoomModal() {
  const modal = getEl('liveRoomModal');
  if (modal) modal.classList.remove('show');
}

function switchLiveRoomTab(tab) {
  const tabHost = getEl('tabHostRoom');
  const tabJoin = getEl('tabJoinRoom');
  const secHost = getEl('hostRoomSection');
  const secJoin = getEl('joinRoomSection');

  if (tabHost && tabJoin && secHost && secJoin) {
    tabHost.classList.toggle('active', tab === 'host');
    tabJoin.classList.toggle('active', tab === 'join');
    secHost.style.display = tab === 'host' ? 'block' : 'none';
    secJoin.style.display = tab === 'join' ? 'block' : 'none';
  }
}

function generateNewHostCode() {
  const input = getEl('hostCodeInput');
  if (input) {
    input.value = generateRoomCode();
  }
}

function confirmStartHost() {
  const input = getEl('hostCodeInput');
  const code = input ? input.value : '';
  closeLiveRoomModal();
  startP2PServer(code);
}

function confirmJoinRoom() {
  const input = getEl('joinCodeInput');
  const code = input ? input.value.trim() : '';
  if (!code) {
    showToast('Please enter a room code.');
    return;
  }
  closeLiveRoomModal();
  joinP2PServer(code);
}

let onConfirmAction = null;

function showConfirmModal(title, message, badgeText = 'Confirmation', onConfirm = null) {
  const titleEl = getEl('confirmModalTitle'); if (titleEl) titleEl.textContent = title;
  const msgEl = getEl('confirmModalMessage'); if (msgEl) msgEl.textContent = message;
  const badgeEl = getEl('confirmModalBadge'); if (badgeEl) badgeEl.textContent = badgeText;
  onConfirmAction = onConfirm;
  const modal = getEl('confirmModal');
  if (modal) modal.classList.add('show');
}

function closeConfirmModal() {
  const modal = getEl('confirmModal');
  if (modal) modal.classList.remove('show');
  onConfirmAction = null;
}

function handleConfirmYes() {
  const action = onConfirmAction;
  closeConfirmModal();
  if (typeof action === 'function') action();
}

function openLegalModal(tab = 'privacy') {
  switchLegalTab(tab);
  const modal = getEl('legalModal');
  if (modal) modal.classList.add('show');
}

function closeLegalModal() {
  const modal = getEl('legalModal');
  if (modal) modal.classList.remove('show');
}

function switchLegalTab(tab) {
  const tabP = getEl('tabPrivacy');
  const tabS = getEl('tabSupport');
  const secP = getEl('legalPrivacyContent');
  const secS = getEl('legalSupportContent');

  if (tabP && tabS && secP && secS) {
    tabP.classList.toggle('active', tab === 'privacy');
    tabS.classList.toggle('active', tab === 'support');
    secP.style.display = tab === 'privacy' ? 'block' : 'none';
    secS.style.display = tab === 'support' ? 'block' : 'none';
  }
}
