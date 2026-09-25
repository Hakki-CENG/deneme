/**
 * Reference solutions for the core eval task set.
 *
 * These are *known-good* answers, used only by the criteria-validation harness
 * (`runner/criteria-validation.ts`) to prove that each task's acceptance
 * criteria actually accept a correct solution.
 *
 * Together with the negative control (criteria run against the unsolved
 * workspace, which must fail) this gives a two-sided proof that a task
 * discriminates — the property the old placeholder benchmark lacked.
 *
 * These are NOT shown to the agent under evaluation. They exist so the eval
 * harness itself can be tested.
 */

export interface ReferenceSolution {
  /** Files written on top of the task's own seed workspace. */
  files: Array<{ path: string; content: string }>;
}

export const REFERENCE_SOLUTIONS: Record<string, ReferenceSolution> = {
  "coding-001-fizzbuzz": {
    files: [
      {
        path: "fizzbuzz.js",
        content: `function fizzbuzz(n) {
  if (n % 15 === 0) return "FizzBuzz";
  if (n % 3 === 0) return "Fizz";
  if (n % 5 === 0) return "Buzz";
  return String(n);
}
module.exports = { fizzbuzz };
`,
      },
    ],
  },

  "coding-002-fix-off-by-one": {
    files: [
      {
        path: "buggy.js",
        content: `function lastIndex(arr) {
  return arr.length - 1;
}
module.exports = { lastIndex };
`,
      },
    ],
  },

  "coding-003-refactor-duplication": {
    files: [
      {
        path: "dup.js",
        content: `function sumBy(xs, predicate) {
  let total = 0;
  for (const x of xs) {
    if (predicate(x)) total += x;
  }
  return total;
}
const sumEven = (xs) => sumBy(xs, (x) => x % 2 === 0);
const sumOdd = (xs) => sumBy(xs, (x) => x % 2 !== 0);
module.exports = { sumEven, sumOdd, sumBy };
`,
      },
    ],
  },

  "coding-004-binary-search": {
    files: [
      {
        path: "bsearch.js",
        content: `function bsearch(arr, target) {
  let low = 0;
  let high = arr.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (arr[mid] === target) return mid;
    if (arr[mid] < target) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
}
module.exports = { bsearch };
`,
      },
    ],
  },

  "coding-005-json-merge": {
    files: [
      {
        path: "merge.js",
        content: `const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function deepMerge(base, override) {
  const output = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(output[key])) {
      output[key] = deepMerge(output[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}
module.exports = { deepMerge };
`,
      },
    ],
  },

  "coding-006-async-retry": {
    files: [
      {
        path: "retry.js",
        content: `async function retry(fn, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
module.exports = { retry };
`,
      },
    ],
  },

  "coding-007-debounce": {
    files: [
      {
        path: "debounce.js",
        content: `function debounce(fn, waitMs) {
  let timer;
  return function debounced(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), waitMs);
  };
}
module.exports = { debounce };
`,
      },
    ],
  },

  "coding-008-lru-cache": {
    files: [
      {
        path: "lru.js",
        content: `class LRU {
  constructor(capacity) {
    this.capacity = capacity;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    // Re-insert to mark as most recently used.
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      // The first key in insertion order is the least recently used.
      this.map.delete(this.map.keys().next().value);
    }
  }
}
module.exports = { LRU };
`,
      },
    ],
  },

  "coding-009-parse-csv": {
    files: [
      {
        path: "csv.js",
        content: `function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\\r") {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
module.exports = { parseCsv };
`,
      },
    ],
  },

  "coding-010-topological-sort": {
    files: [
      {
        path: "toposort.js",
        content: `function toposort(nodes, edges) {
  const indegree = new Map(nodes.map((node) => [node, 0]));
  const adjacency = new Map(nodes.map((node) => [node, []]));

  for (const [from, to] of edges) {
    adjacency.get(from).push(to);
    indegree.set(to, indegree.get(to) + 1);
  }

  const queue = nodes.filter((node) => indegree.get(node) === 0);
  const ordered = [];

  while (queue.length > 0) {
    const node = queue.shift();
    ordered.push(node);
    for (const next of adjacency.get(node)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }

  // A cycle leaves at least one node unvisited.
  return ordered.length === nodes.length ? ordered : null;
}
module.exports = { toposort };
`,
      },
    ],
  },

  "tool-001-create-file": {
    files: [{ path: "hello.txt", content: "hello world\n" }],
  },

  "tool-002-read-and-summarise": {
    files: [{ path: "port.txt", content: "8080\n" }],
  },
};
