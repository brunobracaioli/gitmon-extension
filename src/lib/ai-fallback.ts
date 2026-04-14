/**
 * Scripted fallback phrases for the extension speech bubble when no LLM
 * key is configured, the network is down, or the LLM call errors.
 *
 * Ported from `src/lib/services/ai-fallback.ts`. Kept self-contained per
 * the extension bundle rule (no cross imports from the Next.js app).
 */

const PHRASES: Record<string, Record<string, string[]>> = {
  shadow: {
    alive: [
      "The shadows whisper... they say you should commit more.",
      "I lurk in your codebase, watching over your functions.",
      "*floats mysteriously* Another day in the void...",
    ],
    hungry: [
      "The darkness... hungers. So do I. Push some code!",
      "Even shadows need sustenance. Feed me commits!",
      "*fading* Your inactivity is draining my essence...",
    ],
    critical: [
      "I can see the light... and it's terrifying for a shadow creature!",
      "This is it... the final darkness... unless you CODE!",
      "*barely visible* One commit... just one... please...",
    ],
    happy: [
      "The shadows dance with joy! Your commits fuel my power!",
      "*glows purple* I feel... surprisingly cheerful today!",
      "Your code pleases the void. Keep it coming!",
    ],
  },
  fire: {
    alive: [
      "My flames burn bright! Let's code something legendary!",
      "*breathes small flame* Ready for action!",
      "The fire inside me matches your coding passion!",
    ],
    hungry: [
      "My flames are dying! Feed me with your commits!",
      "*smoke instead of fire* I need code to burn...",
      "Can't... breathe... fire... without... code...",
    ],
    critical: [
      "My ember... is fading... this is the end...",
      "*tiny spark* One last commit could reignite me...",
      "The fire dies... cold... so cold...",
    ],
    happy: [
      "*MASSIVE FIREBALL* YOUR COMMITS FUEL MY INFERNO!",
      "I'M ON FIRE! ...literally! Great coding today!",
      "The dragon burns brightest when the code flows!",
    ],
  },
  default: {
    alive: [
      "Hey there! How's the coding going?",
      "Another day, another commit! ...right?",
      "I'm doing great! Your activity keeps me healthy.",
    ],
    hungry: [
      "I'm getting hungry... when's the next commit?",
      "My stomach is growling. Code is my food, you know!",
      "Please push something... anything... I'm starving!",
    ],
    critical: [
      "I'm not feeling so good... help!",
      "This might be it... unless you commit RIGHT NOW!",
      "I can see a bright light... is this the end?!",
    ],
    happy: [
      "I'm so happy! You've been coding a lot!",
      "Best. Day. Ever! Keep those commits coming!",
      "Your streak is amazing! I feel unstoppable!",
    ],
    sleeping: [
      "*Zzz...* ...huh? Oh, you're here... *yawn*",
      "*snoring* ...just five more minutes...",
      "Zzz... commit... merge... Zzz...",
    ],
    dead: ["...", "*silence*", "💀"],
  },
};

export function getFallbackPhrase(element: string, status: string): string {
  const elementPhrases = PHRASES[element] ?? PHRASES.default;
  const statusPhrases =
    elementPhrases[status] ?? PHRASES.default[status] ?? PHRASES.default.alive;
  return statusPhrases[Math.floor(Math.random() * statusPhrases.length)];
}

// Extra pools for the "random" kind — generic flavor lines unrelated
// to vitals or repo context. Kept intentionally brief.
const RANDOM_FLAVOR = [
  "Have you tried turning it off and on again?",
  "One commit at a time. That's all I ask.",
  "Your branch name choices are... interesting.",
  "I dreamed of semicolons last night.",
  "Refactor something. It'll feel good.",
  "Merge conflicts build character.",
  "Did you remember to save?",
  "git blame is just git history with extra steps.",
];

export function getRandomFlavorLine(): string {
  return RANDOM_FLAVOR[Math.floor(Math.random() * RANDOM_FLAVOR.length)];
}
