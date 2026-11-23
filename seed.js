'use strict';

/**
 * Booknest seeder + offline asset generator.
 *
 * - SqlJsDatabase: synchronous wrapper around sql.js (SQLite compiled to WebAssembly,
 *   no native build step). Every INSERT/UPDATE/DELETE is written back to booknest.db
 *   with fs.writeFileSync (once per committed transaction when inside a transaction).
 * - initDatabase(): loads sql.js, opens booknest.db, enables FK enforcement, applies
 *   schema.sql, seeds the database when empty, and regenerates missing seed assets.
 * - generateCoverSvg(): publisher-style 400x600 SVG cover (also used by the API
 *   when an admin uploads a book without a cover).
 * - generateBookPdf(): valid multi-page PDF 1.4 binary built from scratch.
 *
 * CLI:
 *   node seed.js          -> create schema + seed if empty
 *   node seed.js --reset  -> delete database + uploaded files, then reseed
 */

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');

const ROOT_DIR = __dirname;
const DEFAULT_DB_PATH = path.join(ROOT_DIR, 'booknest.db');
const SCHEMA_PATH = path.join(ROOT_DIR, 'schema.sql');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
const COVERS_DIR = path.join(UPLOADS_DIR, 'covers');
const BOOKS_DIR = path.join(UPLOADS_DIR, 'books');

/* ------------------------------------------------------------------ */
/* Seed data                                                           */
/* ------------------------------------------------------------------ */

const SEED_USERS = [
  { full_name: 'Booknest Administrator', username: 'admin', email: 'admin@booknest.com', password: 'admin123', role: 'admin' },
];

// Sample reader community. `favorites` are category slugs that
// bias who downloads what, so co-download recommendations are meaningful.
const SEED_READERS = [
  { full_name: 'Riley Reader', username: 'reader', email: 'reader@booknest.com', favorites: ['data-ai', 'software-architecture', 'science-physics'] },
  { full_name: 'Ayesha Rahman', username: 'ayesha', email: 'ayesha@booknest.com', favorites: ['classic-literature', 'philosophy-psychology', 'history-society'] },
  { full_name: 'Tanvir Hasan', username: 'tanvir', email: 'tanvir@booknest.com', favorites: ['computer-science', 'software-architecture', 'mathematics'] },
  { full_name: 'Nusrat Jahan', username: 'nusrat', email: 'nusrat@booknest.com', favorites: ['productivity-design', 'philosophy-psychology', 'economics-business'] },
  { full_name: 'Farhan Kabir', username: 'farhan', email: 'farhan@booknest.com', favorites: ['data-ai', 'computer-science', 'mathematics'] },
  { full_name: 'Maya Chen', username: 'maya', email: 'maya@booknest.com', favorites: ['science-physics', 'history-society', 'classic-literature'] },
  { full_name: 'Daniel Okafor', username: 'daniel', email: 'daniel@booknest.com', favorites: ['economics-business', 'productivity-design', 'history-society'] },
];
const SEED_READER_PASSWORD = 'reader123';

const REVIEW_COMMENTS = {
  5: [
    'An essential read. It completely changed how I think about the subject.',
    'Clear, deep and surprisingly readable. Highly recommended.',
    'One of the best books in my library - I keep coming back to it.',
    'Brilliant structure and examples. Worth every page.',
  ],
  4: [
    'Very good overall; a few chapters drag, but the core ideas are excellent.',
    'Solid and insightful. The study notes made reviewing it quick.',
    'A great introduction to the topic, though it assumes some background.',
  ],
  3: ['Useful in places, but denser than I expected.', 'Good ideas with uneven pacing. Worth skimming.'],
  2: ['Not quite what I was looking for, but a few sections were helpful.'],
  1: ['Not for me.'],
};

const SEED_CATEGORIES = [
  {
    category_name: 'Computer Science',
    slug: 'computer-science',
    description: 'Foundations of computation: algorithms, data structures, programming languages and the theory behind them.',
  },
  {
    category_name: 'Software Architecture',
    slug: 'software-architecture',
    description: 'Designing maintainable systems: boundaries, patterns, enterprise integration and long-lived codebases.',
  },
  {
    category_name: 'Data & AI',
    slug: 'data-ai',
    description: 'Data-intensive systems, databases, distributed storage, machine learning and deep learning.',
  },
  {
    category_name: 'Classic Literature',
    slug: 'classic-literature',
    description: 'Enduring novels and literary works that shaped the modern imagination.',
  },
  {
    category_name: 'Science & Physics',
    slug: 'science-physics',
    description: 'Popular science and physics: the universe, space, time and the laws of nature.',
  },
  {
    category_name: 'Productivity & Design',
    slug: 'productivity-design',
    description: 'Human-centered design, focus, craft and working effectively.',
  },
  {
    category_name: 'History & Society',
    slug: 'history-society',
    description: 'How humans, civilizations and societies came to be the way they are.',
  },
  {
    category_name: 'Philosophy & Psychology',
    slug: 'philosophy-psychology',
    description: 'How we think, decide and live well - from Stoic wisdom to modern behavioral science.',
  },
  {
    category_name: 'Economics & Business',
    slug: 'economics-business',
    description: 'Markets, money, startups and the ideas that drive economic progress.',
  },
  {
    category_name: 'Mathematics',
    slug: 'mathematics',
    description: 'The beauty, logic and surprising usefulness of mathematical thinking.',
  },
];

// downloads = number of sample Download rows generated for trending stats
const SEED_BOOKS = [
  {
    slug: 'structure-and-interpretation-of-computer-programs',
    title: 'Structure and Interpretation of Computer Programs',
    author: 'Harold Abelson & Gerald Jay Sussman',
    isbn: '9780262510875',
    published_year: 1996,
    pages: 657,
    category: 'computer-science',
    downloads: 14,
    description:
      'A landmark introduction to computer science that teaches programming as a way of thinking. Using Scheme, it builds from procedures and recursion to data abstraction, state, metalinguistic abstraction and register machines.',
    topics: ['Building abstractions with procedures', 'Building abstractions with data', 'Modularity, objects and state', 'Metalinguistic abstraction and interpreters'],
  },
  {
    slug: 'introduction-to-algorithms',
    title: 'Introduction to Algorithms',
    author: 'Thomas H. Cormen, Charles E. Leiserson, Ronald L. Rivest & Clifford Stein',
    isbn: '9780262033848',
    published_year: 2009,
    pages: 1312,
    category: 'computer-science',
    downloads: 22,
    description:
      'The comprehensive reference on algorithm design and analysis, covering sorting, graph algorithms, dynamic programming, greedy strategies, amortized analysis and NP-completeness with rigorous yet accessible proofs.',
    topics: ['Asymptotic analysis and recurrences', 'Sorting and order statistics', 'Dynamic programming and greedy algorithms', 'Graph algorithms and shortest paths'],
  },
  {
    slug: 'clean-architecture',
    title: 'Clean Architecture',
    author: 'Robert C. Martin',
    isbn: '9780134494166',
    published_year: 2017,
    pages: 432,
    category: 'software-architecture',
    downloads: 18,
    description:
      'A craftsman\'s guide to software structure and design. It explains the SOLID principles, component cohesion and coupling, and the dependency rule that keeps business policy independent of frameworks, databases and user interfaces.',
    topics: ['The SOLID design principles', 'Component cohesion and coupling', 'The dependency rule and boundaries', 'Keeping frameworks and databases as details'],
  },
  {
    slug: 'patterns-of-enterprise-application-architecture',
    title: 'Patterns of Enterprise Application Architecture',
    author: 'Martin Fowler',
    isbn: '9780321127426',
    published_year: 2002,
    pages: 560,
    category: 'software-architecture',
    downloads: 9,
    description:
      'A catalog of more than forty patterns for building enterprise applications, including Domain Model, Active Record, Data Mapper, Unit of Work, Lazy Load and patterns for web presentation and concurrency.',
    topics: ['Layering and domain logic patterns', 'Object-relational mapping patterns', 'Web presentation patterns', 'Offline concurrency and session state'],
  },
  {
    slug: 'designing-data-intensive-applications',
    title: 'Designing Data-Intensive Applications',
    author: 'Martin Kleppmann',
    isbn: '9781449373320',
    published_year: 2017,
    pages: 616,
    category: 'data-ai',
    downloads: 27,
    description:
      'An in-depth tour of the ideas behind reliable, scalable and maintainable data systems: storage engines, replication, partitioning, transactions, consistency models, batch and stream processing.',
    topics: ['Data models and query languages', 'Storage engines and indexing', 'Replication, partitioning and transactions', 'Batch and stream processing'],
  },
  {
    slug: 'deep-learning',
    title: 'Deep Learning',
    author: 'Ian Goodfellow, Yoshua Bengio & Aaron Courville',
    isbn: '9780262035613',
    published_year: 2016,
    pages: 800,
    category: 'data-ai',
    downloads: 16,
    description:
      'The definitive textbook on deep learning, covering the mathematical background, modern practical deep networks, regularization, optimization, convolutional and recurrent networks, and research perspectives.',
    topics: ['Linear algebra, probability and numerical computation', 'Deep feedforward networks and regularization', 'Convolutional and recurrent networks', 'Representation learning and generative models'],
  },
  {
    slug: 'pride-and-prejudice',
    title: 'Pride and Prejudice',
    author: 'Jane Austen',
    isbn: '9780141439518',
    published_year: 1813,
    pages: 480,
    category: 'classic-literature',
    downloads: 12,
    description:
      'Elizabeth Bennet and Fitzwilliam Darcy navigate manners, marriage, wealth and misjudgment in Regency England in one of the most beloved comedies of character ever written.',
    topics: ['First impressions and misjudgment', 'Marriage, class and economic security', 'Irony and the narrative voice', 'Growth through self-knowledge'],
  },
  {
    slug: 'frankenstein',
    title: 'Frankenstein',
    author: 'Mary Shelley',
    isbn: '9780141439471',
    published_year: 1818,
    pages: 280,
    category: 'classic-literature',
    downloads: 7,
    description:
      'Victor Frankenstein\'s ambition to create life produces a being who longs for companionship and is met with horror. A founding work of science fiction about responsibility, isolation and the limits of knowledge.',
    topics: ['Ambition and the pursuit of forbidden knowledge', 'Creator and creation', 'Isolation and the need for companionship', 'The frame narrative structure'],
  },
  {
    slug: 'a-brief-history-of-time',
    title: 'A Brief History of Time',
    author: 'Stephen Hawking',
    isbn: '9780553380163',
    published_year: 1988,
    pages: 212,
    category: 'science-physics',
    downloads: 11,
    description:
      'From the Big Bang to black holes, Hawking explains the nature of space and time, the expanding universe, the uncertainty principle and the quest for a unified theory in clear, engaging prose.',
    topics: ['Our picture of the universe', 'Space, time and relativity', 'Black holes and Hawking radiation', 'The search for a unified theory'],
  },
  {
    slug: 'cosmos',
    title: 'Cosmos',
    author: 'Carl Sagan',
    isbn: '9780345539434',
    published_year: 1980,
    pages: 432,
    category: 'science-physics',
    downloads: 8,
    description:
      'A sweeping journey through fifteen billion years of cosmic evolution, connecting astronomy, history and the human story, and celebrating the scientific method as a way of knowing.',
    topics: ['The shores of the cosmic ocean', 'The lives of the stars', 'The history of scientific discovery', 'Our place among the worlds'],
  },
  {
    slug: 'the-design-of-everyday-things',
    title: 'The Design of Everyday Things',
    author: 'Don Norman',
    isbn: '9780465050659',
    published_year: 2013,
    pages: 368,
    category: 'productivity-design',
    downloads: 10,
    description:
      'Why do some products satisfy while others frustrate? Norman introduces affordances, signifiers, mappings, feedback and conceptual models, and shows how human-centered design prevents error.',
    topics: ['Affordances and signifiers', 'Mappings, feedback and constraints', 'Human error and how to design for it', 'Human-centered design process'],
  },
  {
    slug: 'deep-work',
    title: 'Deep Work',
    author: 'Cal Newport',
    isbn: '9781455586691',
    published_year: 2016,
    pages: 296,
    category: 'productivity-design',
    downloads: 19,
    description:
      'An argument that the ability to focus without distraction on cognitively demanding tasks is becoming rare and valuable, with practical rules for cultivating deep work in a distracted world.',
    topics: ['Why deep work is valuable and rare', 'Work deeply: rituals and routines', 'Embrace boredom', 'Quit social media and drain the shallows'],
  },
  /* ---- Catalog expansion (seed catalog version 2) ---- */
  {
    slug: 'code-the-hidden-language',
    title: 'Code: The Hidden Language of Computer Hardware and Software',
    author: 'Charles Petzold',
    isbn: '9780735611313',
    published_year: 2000,
    pages: 393,
    category: 'computer-science',
    downloads: 13,
    description:
      'Starting from flashlights and Morse code, Petzold builds up, step by step, how relays, logic gates, memory and processors combine into the computers we use every day.',
    topics: ['Codes and combinations', 'Logic gates and binary arithmetic', 'Memory and the clock', 'From processors to operating systems'],
  },
  {
    slug: 'domain-driven-design',
    title: 'Domain-Driven Design',
    author: 'Eric Evans',
    isbn: '9780321125217',
    published_year: 2003,
    pages: 560,
    category: 'software-architecture',
    downloads: 11,
    description:
      'A guide to tackling complexity in the heart of software by building a shared language with domain experts and shaping code around a rich, evolving model of the business.',
    topics: ['Ubiquitous language', 'Entities, value objects and aggregates', 'Bounded contexts', 'Strategic design and context maps'],
  },
  {
    slug: 'artificial-intelligence-a-modern-approach',
    title: 'Artificial Intelligence: A Modern Approach',
    author: 'Stuart Russell & Peter Norvig',
    isbn: '9780134610993',
    published_year: 2020,
    pages: 1136,
    category: 'data-ai',
    downloads: 21,
    description:
      'The leading textbook on artificial intelligence, covering intelligent agents, search, logic, planning, probabilistic reasoning, machine learning, language, vision and the ethics of AI.',
    topics: ['Intelligent agents and search', 'Knowledge, reasoning and planning', 'Uncertainty and probabilistic models', 'Machine learning and its impact'],
  },
  {
    slug: 'moby-dick',
    title: 'Moby-Dick',
    author: 'Herman Melville',
    isbn: '9780142437247',
    published_year: 1851,
    pages: 720,
    category: 'classic-literature',
    downloads: 6,
    description:
      'Ishmael joins the whaling ship Pequod and its obsessed captain Ahab in pursuit of the white whale, in a sprawling epic about fate, nature, faith and the limits of human will.',
    topics: ['Obsession and fate', 'Humanity versus nature', 'Symbolism of the white whale', 'The many voices of the narrative'],
  },
  {
    slug: 'the-selfish-gene',
    title: 'The Selfish Gene',
    author: 'Richard Dawkins',
    isbn: '9780198788607',
    published_year: 1976,
    pages: 496,
    category: 'science-physics',
    downloads: 9,
    description:
      'A gene-centered view of evolution explaining how altruism, cooperation and competition emerge from natural selection, and introducing the idea of the meme.',
    topics: ['Replicators and survival machines', 'Kin selection and altruism', 'Game theory in nature', 'Memes: the new replicators'],
  },
  {
    slug: 'atomic-habits',
    title: 'Atomic Habits',
    author: 'James Clear',
    isbn: '9780735211292',
    published_year: 2018,
    pages: 320,
    category: 'productivity-design',
    downloads: 24,
    description:
      'A practical framework for building good habits and breaking bad ones through tiny changes that compound, built around making habits obvious, attractive, easy and satisfying.',
    topics: ['The compound effect of small habits', 'Identity-based habits', 'The four laws of behavior change', 'Environment design'],
  },
  {
    slug: 'sapiens',
    title: 'Sapiens: A Brief History of Humankind',
    author: 'Yuval Noah Harari',
    isbn: '9780062316097',
    published_year: 2015,
    pages: 464,
    category: 'history-society',
    downloads: 23,
    description:
      'How did one species come to dominate the planet? Harari traces humankind through the cognitive, agricultural and scientific revolutions and asks where we are heading next.',
    topics: ['The cognitive revolution', 'The agricultural revolution', 'The unification of humankind', 'The scientific revolution'],
  },
  {
    slug: 'guns-germs-and-steel',
    title: 'Guns, Germs, and Steel',
    author: 'Jared Diamond',
    isbn: '9780393354324',
    published_year: 1997,
    pages: 528,
    category: 'history-society',
    downloads: 10,
    description:
      'Why did some societies conquer others? Diamond argues that geography, domesticable plants and animals, and disease shaped the fates of civilizations far more than any innate difference between peoples.',
    topics: ['Geography and the rise of farming', 'Domestication of plants and animals', 'Germs and conquest', 'Writing, technology and the state'],
  },
  {
    slug: 'thinking-fast-and-slow',
    title: 'Thinking, Fast and Slow',
    author: 'Daniel Kahneman',
    isbn: '9780374533557',
    published_year: 2011,
    pages: 499,
    category: 'philosophy-psychology',
    downloads: 20,
    description:
      'Nobel laureate Daniel Kahneman explores the two systems that drive how we think - one fast and intuitive, one slow and deliberate - and the biases that shape our judgments and choices.',
    topics: ['System 1 and System 2', 'Heuristics and biases', 'Overconfidence', 'Prospect theory and choices'],
  },
  {
    slug: 'meditations',
    title: 'Meditations',
    author: 'Marcus Aurelius',
    isbn: '9780812968255',
    published_year: 180,
    pages: 256,
    category: 'philosophy-psychology',
    downloads: 15,
    description:
      'The private reflections of a Roman emperor on duty, resilience and living according to reason - a timeless handbook of Stoic philosophy.',
    topics: ['What is in our control', 'Duty and service to others', 'Impermanence and perspective', 'Living according to nature'],
  },
  {
    slug: 'the-wealth-of-nations',
    title: 'The Wealth of Nations',
    author: 'Adam Smith',
    isbn: '9780553585971',
    published_year: 1776,
    pages: 1264,
    category: 'economics-business',
    downloads: 7,
    description:
      'The founding work of modern economics, explaining the division of labor, free markets, the role of self-interest and how nations grow prosperous.',
    topics: ['The division of labor', 'Prices, wages and profit', 'The invisible hand', 'The role of government'],
  },
  {
    slug: 'zero-to-one',
    title: 'Zero to One',
    author: 'Peter Thiel',
    isbn: '9780804139298',
    published_year: 2014,
    pages: 224,
    category: 'economics-business',
    downloads: 14,
    description:
      'Notes on startups and how to build the future: why the best companies create something genuinely new instead of competing, and how to find the secrets others miss.',
    topics: ['Going from zero to one', 'Monopoly versus competition', 'The power law', 'Secrets and founders'],
  },
  {
    slug: 'godel-escher-bach',
    title: 'Gödel, Escher, Bach',
    author: 'Douglas R. Hofstadter',
    isbn: '9780465026562',
    published_year: 1979,
    pages: 777,
    category: 'mathematics',
    downloads: 12,
    description:
      'A playful, Pulitzer Prize-winning exploration of self-reference, recursion and meaning, weaving together the logic of Gödel, the art of Escher and the music of Bach.',
    topics: ['Formal systems and theorems', 'Recursion and self-reference', 'Strange loops', 'Minds, meaning and machines'],
  },
  {
    slug: 'how-not-to-be-wrong',
    title: 'How Not to Be Wrong',
    author: 'Jordan Ellenberg',
    isbn: '9780143127536',
    published_year: 2014,
    pages: 480,
    category: 'mathematics',
    downloads: 9,
    description:
      'An entertaining tour of how mathematical thinking helps us reason about everyday life, from lotteries and elections to statistics, regression and the pitfalls of linear thinking.',
    topics: ['Linearity and its limits', 'Inference and probability', 'Expectation and risk', 'Regression and correlation'],
  },
  /* ---- Catalog expansion: 50 additional titles ---- */
  {
    slug: 'operating-systems-three-easy-pieces',
    title: 'Operating Systems: Three Easy Pieces',
    author: 'Remzi H. Arpaci-Dusseau & Andrea C. Arpaci-Dusseau',
    isbn: '9781985086593',
    published_year: 2018,
    pages: 710,
    category: 'computer-science',
    downloads: 19,
    description:
      'A clear, hands-on tour of modern operating systems organized around three fundamental ideas: virtualization of CPU and memory, concurrency locks and threads, and persistent file systems.',
    topics: ['Process and memory virtualization', 'Locks, condition variables and semaphores', 'File systems and journaling', 'Distributed storage fundamentals'],
  },
  {
    slug: 'computer-networking-a-top-down-approach',
    title: 'Computer Networking: A Top-Down Approach',
    author: 'James F. Kurose & Keith W. Ross',
    isbn: '9780133594140',
    published_year: 2016,
    pages: 864,
    category: 'computer-science',
    downloads: 17,
    description:
      'An application-first guide to how the Internet works, moving down from HTTP, DNS and sockets through TCP congestion control, IP routing and wireless link layers.',
    topics: ['Application layer protocols and sockets', 'Reliable transport and TCP congestion control', 'Network layer routing algorithms', 'Link layer and wireless networks'],
  },
  {
    slug: 'compilers-principles-techniques-and-tools',
    title: 'Compilers: Principles, Techniques, and Tools',
    author: 'Alfred V. Aho, Monica S. Lam, Ravi Sethi & Jeffrey D. Ullman',
    isbn: '9780321486813',
    published_year: 2006,
    pages: 1040,
    category: 'computer-science',
    downloads: 11,
    description:
      'The classic Dragon Book on compiler construction, detailing lexical analysis, context-free parsing, syntax-directed translation, intermediate code generation and register allocation.',
    topics: ['Lexical and syntax analysis', 'Type checking and runtime environments', 'Intermediate code generation', 'Machine-independent optimizations'],
  },
  {
    slug: 'computer-systems-a-programmers-perspective',
    title: 'Computer Systems: A Programmer\'s Perspective',
    author: 'Randal E. Bryant & David R. O\'Hallaron',
    isbn: '9780134092669',
    published_year: 2015,
    pages: 1120,
    category: 'computer-science',
    downloads: 15,
    description:
      'Explains how hardware, compilers, operating systems and networks interact from the programmer\'s viewpoint—covering machine-level assembly, processor pipelining, cache memory and virtual memory.',
    topics: ['Data representation and x86-64 assembly', 'Memory hierarchy and cache performance', 'Linking and exceptional control flow', 'Virtual memory and dynamic allocation'],
  },
  {
    slug: 'the-c-programming-language',
    title: 'The C Programming Language',
    author: 'Brian W. Kernighan & Dennis M. Ritchie',
    isbn: '9780131103627',
    published_year: 1988,
    pages: 272,
    category: 'computer-science',
    downloads: 16,
    description:
      'The concise, authoritative manual on C written by its creators, demonstrating pointers, memory management, structures and UNIX system interfaces with crystalline precision.',
    topics: ['Types, operators and control flow', 'Pointers, arrays and dynamic memory', 'Structures and input/output libraries', 'The UNIX system interface'],
  },
  {
    slug: 'design-patterns-gang-of-four',
    title: 'Design Patterns: Elements of Reusable Object-Oriented Software',
    author: 'Erich Gamma, Richard Helm, Ralph Johnson & John Vlissides',
    isbn: '9780201633610',
    published_year: 1994,
    pages: 395,
    category: 'software-architecture',
    downloads: 21,
    description:
      'The foundational catalog of 23 creational, structural and behavioral object-oriented design patterns that gave software engineers a shared vocabulary for flexible design.',
    topics: ['Creational patterns: Factory, Builder and Singleton', 'Structural patterns: Adapter, Decorator and Proxy', 'Behavioral patterns: Observer, Strategy and Command', 'Composition over inheritance'],
  },
  {
    slug: 'refactoring-improving-the-design-of-existing-code',
    title: 'Refactoring: Improving the Design of Existing Code',
    author: 'Martin Fowler',
    isbn: '9780134757599',
    published_year: 2018,
    pages: 448,
    category: 'software-architecture',
    downloads: 18,
    description:
      'A step-by-step guide to transforming messy codebases safely through small, behavior-preserving transformations backed by automated tests.',
    topics: ['Recognizing code smells', 'Building self-testing code', 'Extracting functions and classes', 'Simplifying conditional logic'],
  },
  {
    slug: 'building-microservices',
    title: 'Building Microservices',
    author: 'Sam Newman',
    isbn: '9781492034025',
    published_year: 2021,
    pages: 612,
    category: 'software-architecture',
    downloads: 14,
    description:
      'Practical guidance on decomposing monoliths, modeling service boundaries, handling distributed transactions, deploying independently and observing production systems.',
    topics: ['Modeling microservices around domain boundaries', 'Synchronous versus event-driven communication', 'Splitting monolithic databases safely', 'Resiliency, observability and security'],
  },
  {
    slug: 'the-pragmatic-programmer',
    title: 'The Pragmatic Programmer',
    author: 'David Thomas & Andrew Hunt',
    isbn: '9780135957059',
    published_year: 2019,
    pages: 352,
    category: 'software-architecture',
    downloads: 25,
    description:
      'Timeless advice on software craftsmanship, covering orthogonality, tracer bullets, debugging mindset, concurrency, refactoring and taking responsibility for your work.',
    topics: ['DRY, orthogonality and reversibility', 'Tracer bullets and prototyping', 'Debugging and defensive programming', 'Pragmatic teams and automation'],
  },
  {
    slug: 'site-reliability-engineering',
    title: 'Site Reliability Engineering',
    author: 'Betsy Beyer, Chris Jones, Jennifer Petoff & Niall Richard Murphy',
    isbn: '9781491929124',
    published_year: 2016,
    pages: 552,
    category: 'software-architecture',
    downloads: 12,
    description:
      'How Google builds, monitors and operates planetary-scale services using error budgets, service level objectives, blameless postmortems and toil elimination.',
    topics: ['Service level objectives and error budgets', 'Eliminating operational toil', 'Monitoring, alerting and incident response', 'Load balancing and cascading failure prevention'],
  },
  {
    slug: 'database-system-concepts',
    title: 'Database System Concepts',
    author: 'Abraham Silberschatz, Henry F. Korth & S. Sudarshan',
    isbn: '9780078022159',
    published_year: 2019,
    pages: 1376,
    category: 'data-ai',
    downloads: 20,
    description:
      'The classic textbook covering relational algebra, SQL, entity-relationship modeling, normalization theory, B+ tree indexing, query optimization and ACID transaction recovery.',
    topics: ['Relational model and SQL', 'Entity-relationship design and normalization', 'Indexing, hashing and query processing', 'Concurrency control and recovery'],
  },
  {
    slug: 'hands-on-machine-learning',
    title: 'Hands-On Machine Learning with Scikit-Learn, Keras, and TensorFlow',
    author: 'Aurélien Géron',
    isbn: '9781098125974',
    published_year: 2022,
    pages: 862,
    category: 'data-ai',
    downloads: 24,
    description:
      'An end-to-end practical guide to building intelligent systems, progressing from linear models, decision trees and ensembles to deep neural networks, transformers and reinforcement learning.',
    topics: ['End-to-end machine learning pipelines', 'Classification, SVMs and ensemble methods', 'Training deep neural networks', 'Computer vision, NLP and transformers'],
  },
  {
    slug: 'pattern-recognition-and-machine-learning',
    title: 'Pattern Recognition and Machine Learning',
    author: 'Christopher M. Bishop',
    isbn: '9780387310732',
    published_year: 2006,
    pages: 738,
    category: 'data-ai',
    downloads: 13,
    description:
      'A rigorous probabilistic foundation for machine learning, unifying Bayesian inference, graphical models, kernel methods, expectation-maximization and approximate inference.',
    topics: ['Probability distributions and Bayesian inference', 'Linear models and kernel methods', 'Graphical models and mixture distributions', 'Sampling and variational inference'],
  },
  {
    slug: 'database-internals',
    title: 'Database Internals',
    author: 'Alex Petrov',
    isbn: '9781492040347',
    published_year: 2019,
    pages: 372,
    category: 'data-ai',
    downloads: 15,
    description:
      'A deep dive into how modern databases store and replicate data—contrasting B-Trees with Log-Structured Merge (LSM) trees and dissecting consensus protocols like Raft and Paxos.',
    topics: ['B-Tree and LSM-Tree storage engines', 'Page layout, caching and compaction', 'Distributed replication and failure detection', 'Consensus algorithms: Paxos and Raft'],
  },
  {
    slug: 'reinforcement-learning-an-introduction',
    title: 'Reinforcement Learning: An Introduction',
    author: 'Richard S. Sutton & Andrew G. Barto',
    isbn: '9780262039246',
    published_year: 2018,
    pages: 552,
    category: 'data-ai',
    downloads: 14,
    description:
      'The foundational text on learning from interaction, covering multi-armed bandits, Markov decision processes, dynamic programming, Monte Carlo methods, Q-learning and policy gradients.',
    topics: ['Multi-armed bandits and exploration', 'Finite Markov decision processes', 'Temporal-difference and Q-learning', 'Function approximation and policy gradients'],
  },
  {
    slug: '1984',
    title: '1984',
    author: 'George Orwell',
    isbn: '9780451524935',
    published_year: 1949,
    pages: 328,
    category: 'classic-literature',
    downloads: 22,
    description:
      'Winston Smith lives under the constant surveillance of Big Brother in Oceania, where history is rewritten daily and independent thought is the gravest crime.',
    topics: ['Totalitarianism and surveillance', 'Language, Newspeak and truth', 'Memory and historical revisionism', 'Individual conscience under oppression'],
  },
  {
    slug: 'crime-and-punishment',
    title: 'Crime and Punishment',
    author: 'Fyodor Dostoevsky',
    isbn: '9780143058144',
    published_year: 1866,
    pages: 671,
    category: 'classic-literature',
    downloads: 15,
    description:
      'Impoverished former student Rodion Raskolnikov commits a murder to test his theory of extraordinary men, only to be consumed by guilt, paranoia and moral awakening in St. Petersburg.',
    topics: ['Guilt, conscience and redemption', 'Utilitarianism and moral nihilism', 'Alienation in urban St. Petersburg', 'Psychological realism'],
  },
  {
    slug: 'the-great-gatsby',
    title: 'The Great Gatsby',
    author: 'F. Scott Fitzgerald',
    isbn: '9780743273565',
    published_year: 1925,
    pages: 180,
    category: 'classic-literature',
    downloads: 18,
    description:
      'Through the eyes of Nick Carraway, Jay Gatsby\'s lavish Jazz Age parties reveal an obsessive pursuit of wealth, status and an idealized past that can never be recaptured.',
    topics: ['The American Dream and illusion', 'Class, wealth and social carelessness', 'Nostalgia and the unattainable past', 'Symbolism of the green light'],
  },
  {
    slug: 'to-kill-a-mockingbird',
    title: 'To Kill a Mockingbird',
    author: 'Harper Lee',
    isbn: '9780061120084',
    published_year: 1960,
    pages: 336,
    category: 'classic-literature',
    downloads: 19,
    description:
      'Set in Depression-era Alabama, young Scout Finch watches her father Atticus defend an innocent Black man against racial prejudice and small-town injustice.',
    topics: ['Moral courage and empathy', 'Racial injustice and the legal system', 'Childhood innocence and growing up', 'Social hierarchy in Maycomb'],
  },
  {
    slug: 'the-brothers-karamazov',
    title: 'The Brothers Karamazov',
    author: 'Fyodor Dostoevsky',
    isbn: '9780374528379',
    published_year: 1880,
    pages: 824,
    category: 'classic-literature',
    downloads: 10,
    description:
      'A towering philosophical novel about faith, free will, doubt and patricide, centered on three starkly different brothers and their dissolute father.',
    topics: ['Faith, doubt and free will', 'The Grand Inquisitor parable', 'Moral responsibility for one another', 'Family conflict and passion'],
  },
  {
    slug: 'the-feynman-lectures-on-physics',
    title: 'The Feynman Lectures on Physics',
    author: 'Richard P. Feynman, Robert B. Leighton & Matthew Sands',
    isbn: '9780465023820',
    published_year: 1964,
    pages: 1552,
    category: 'science-physics',
    downloads: 18,
    description:
      'Richard Feynman\'s legendary Caltech lectures illuminating mechanics, radiation, electromagnetism and quantum behavior from first principles with unmatched intuition.',
    topics: ['Atoms in motion and conservation laws', 'Relativity, radiation and optics', 'Electromagnetism and Maxwell\'s equations', 'Quantum behavior and probability amplitudes'],
  },
  {
    slug: 'the-origin-of-species',
    title: 'On the Origin of Species',
    author: 'Charles Darwin',
    isbn: '9780451529060',
    published_year: 1859,
    pages: 502,
    category: 'science-physics',
    downloads: 12,
    description:
      'Darwin\'s epoch-making argument that all species descend from common ancestors through variation, inheritance and natural selection.',
    topics: ['Variation under domestication and nature', 'Struggle for existence and natural selection', 'Geographical distribution of species', 'Common descent and the tree of life'],
  },
  {
    slug: 'astrophysics-for-people-in-a-hurry',
    title: 'Astrophysics for People in a Hurry',
    author: 'Neil deGrasse Tyson',
    isbn: '9780393609394',
    published_year: 2017,
    pages: 224,
    category: 'science-physics',
    downloads: 16,
    description:
      'A brisk, witty tour of cosmic essentials—from the Big Bang, dark matter and dark energy to exoplanets and the cosmic perspective.',
    topics: ['The first fractions of a second', 'Dark matter and dark energy', 'The periodic table of the cosmos', 'Exoplanets and the cosmic perspective'],
  },
  {
    slug: 'the-elegant-universe',
    title: 'The Elegant Universe',
    author: 'Brian Greene',
    isbn: '9780393338102',
    published_year: 1999,
    pages: 464,
    category: 'science-physics',
    downloads: 11,
    description:
      'Explores the clash between general relativity and quantum mechanics and shows how string theory attempts to unify all forces of nature in extra dimensions.',
    topics: ['Special and general relativity', 'Quantum uncertainty and fluctuations', 'Strings, vibrations and extra dimensions', 'Black holes and the fabric of spacetime'],
  },
  {
    slug: 'surely-youre-joking-mr-feynman',
    title: 'Surely You\'re Joking, Mr. Feynman!',
    author: 'Richard P. Feynman',
    isbn: '9780393355628',
    published_year: 1985,
    pages: 400,
    category: 'science-physics',
    downloads: 17,
    description:
      'Playful autobiographical adventures from cracking safes at Los Alamos to playing bongos in Brazil, celebrating curiosity, skepticism and the joy of figuring things out.',
    topics: ['Curiosity and hands-on experimentation', 'Los Alamos and the Manhattan Project', 'Cargo cult science and integrity', 'Learning through play'],
  },
  {
    slug: 'dont-make-me-think',
    title: 'Don\'t Make Me Think',
    author: 'Steve Krug',
    isbn: '9780321965516',
    published_year: 2014,
    pages: 216,
    category: 'productivity-design',
    downloads: 16,
    description:
      'A commonsense guide to web and mobile usability explaining why users scan rather than read, how to design self-evident navigation and how to run lightweight usability tests.',
    topics: ['How users really use the web', 'Billboard design and visual hierarchy', 'Navigation and information scent', 'Usability testing on a shoestring'],
  },
  {
    slug: 'essentialism',
    title: 'Essentialism: The Disciplined Pursuit of Less',
    author: 'Greg McKeown',
    isbn: '9780804137386',
    published_year: 2014,
    pages: 272,
    category: 'productivity-design',
    downloads: 15,
    description:
      'A systematic discipline for discerning what is truly vital, eliminating trivial obligations and channeling effort into the highest-leverage work.',
    topics: ['The mindset of choice and trade-offs', 'Exploring and discerning the vital few', 'Eliminating nonessentials gracefully', 'Building effortless execution routines'],
  },
  {
    slug: 'getting-things-done',
    title: 'Getting Things Done',
    author: 'David Allen',
    isbn: '9780143126560',
    published_year: 2015,
    pages: 352,
    category: 'productivity-design',
    downloads: 14,
    description:
      'A stress-free productivity workflow built on capturing every commitment outside your head, clarifying concrete next actions and reviewing trusted lists weekly.',
    topics: ['Capture, clarify, organize, reflect and engage', 'Defining concrete next actions', 'The weekly review habit', 'Horizons of focus'],
  },
  {
    slug: 'the-elements-of-typographic-style',
    title: 'The Elements of Typographic Style',
    author: 'Robert Bringhurst',
    isbn: '9780881792126',
    published_year: 2012,
    pages: 398,
    category: 'productivity-design',
    downloads: 9,
    description:
      'The revered manual of typography covering rhythm, proportion, page geometry, serif and sans-serif pairing and the historical craft of readable text.',
    topics: ['Rhythm, proportion and measure', 'Harmony and counterpoint in type', 'Page layout and grid systems', 'Choosing and combining typefaces'],
  },
  {
    slug: 'show-your-work',
    title: 'Show Your Work!',
    author: 'Austin Kleon',
    isbn: '9780761178972',
    published_year: 2014,
    pages: 224,
    category: 'productivity-design',
    downloads: 13,
    description:
      'Ten practical rules for sharing your creative process openly, documenting small daily progress and building an audience around genuine craft.',
    topics: ['Share process rather than finished products', 'Think in small daily dispatches', 'Teach what you know openly', 'Stick around and keep learning'],
  },
  {
    slug: 'the-silk-roads',
    title: 'The Silk Roads: A New History of the World',
    author: 'Peter Frankopan',
    isbn: '9781101912379',
    published_year: 2015,
    pages: 656,
    category: 'history-society',
    downloads: 14,
    description:
      'Reframes world history around the trade routes linking East and West across Central Asia, showing how silk, silver, religions and empires flowed along the heart of Eurasia.',
    topics: ['The birth of the Silk Roads', 'Spread of faiths and ideas across Eurasia', 'Empires of silver, spice and oil', 'The modern resurgence of Central Asia'],
  },
  {
    slug: '1491-new-revelations-of-the-americas',
    title: '1491: New Revelations of the Americas Before Columbus',
    author: 'Charles C. Mann',
    isbn: '9781400032051',
    published_year: 2005,
    pages: 541,
    category: 'history-society',
    downloads: 11,
    description:
      'Synthesizes archaeology, ecology and genetics to show that pre-Columbian societies were far larger, older and more sophisticated in shaping their landscapes than once believed.',
    topics: ['Demographics before 1492', 'Andean and Mesoamerican civilizations', 'Ecological engineering of the Americas', 'Epidemics and the Columbian encounter'],
  },
  {
    slug: 'a-peoples-history-of-the-united-states',
    title: 'A People\'s History of the United States',
    author: 'Howard Zinn',
    isbn: '9780062397348',
    published_year: 2015,
    pages: 729,
    category: 'history-society',
    downloads: 12,
    description:
      'Tells American history from the perspective of ordinary workers, women, Indigenous peoples and civil rights movements rather than presidents and generals.',
    topics: ['Colonial encounters and resistance', 'Industrialization and labor movements', 'Civil rights and social reform', 'History from the bottom up'],
  },
  {
    slug: 'the-lessons-of-history',
    title: 'The Lessons of History',
    author: 'Will Durant & Ariel Durant',
    isbn: '9781439149959',
    published_year: 1968,
    pages: 128,
    category: 'history-society',
    downloads: 15,
    description:
      'A distilled synthesis of patterns across five thousand years of human civilization—examining biology, religion, morals, economics, government and war.',
    topics: ['Geography, biology and human nature', 'Morals, religion and social cohesion', 'Economics, inequality and redistribution', 'Growth and decay of civilizations'],
  },
  {
    slug: 'why-nations-fail',
    title: 'Why Nations Fail',
    author: 'Daron Acemoglu & James A. Robinson',
    isbn: '9780307719225',
    published_year: 2012,
    pages: 544,
    category: 'history-society',
    downloads: 17,
    description:
      'Argues that political and economic institutions—inclusive versus extractive—determine why some countries prosper while others stagnate.',
    topics: ['Inclusive versus extractive institutions', 'Critical junctures in history', 'Why elites resist creative destruction', 'Breaking out of institutional poverty'],
  },
  {
    slug: 'mans-search-for-meaning',
    title: 'Man\'s Search for Meaning',
    author: 'Viktor E. Frankl',
    isbn: '9780807014271',
    published_year: 1946,
    pages: 184,
    category: 'philosophy-psychology',
    downloads: 21,
    description:
      'Psychiatrist Viktor Frankl recounts his survival in Nazi concentration camps and introduces logotherapy—the principle that finding purpose sustains human resilience in any circumstance.',
    topics: ['Experiences in a concentration camp', 'Freedom to choose one\'s attitude', 'Logotherapy and the will to meaning', 'Tragic optimism'],
  },
  {
    slug: 'letters-from-a-stoic',
    title: 'Letters from a Stoic',
    author: 'Seneca',
    isbn: '9780140442106',
    published_year: 65,
    pages: 256,
    category: 'philosophy-psychology',
    downloads: 14,
    description:
      'Seneca\'s personal letters to his friend Lucilius offering pragmatic counsel on time, friendship, adversity, wealth and peace of mind.',
    topics: ['On the shortness and value of time', 'Friendship and moral character', 'Practicing voluntary discomfort', 'Tranquility in the face of fortune'],
  },
  {
    slug: 'nicomachean-ethics',
    title: 'Nicomachean Ethics',
    author: 'Aristotle',
    isbn: '9780140449495',
    published_year: 340,
    pages: 329,
    category: 'philosophy-psychology',
    downloads: 11,
    description:
      'Aristotle\'s inquiry into human flourishing (eudaimonia), showing how moral virtue is cultivated through habit and balanced along the golden mean.',
    topics: ['Human flourishing and the highest good', 'Virtue as habit and the golden mean', 'Practical wisdom (phronesis)', 'Friendship and the contemplative life'],
  },
  {
    slug: 'flow-the-psychology-of-optimal-experience',
    title: 'Flow: The Psychology of Optimal Experience',
    author: 'Mihaly Csikszentmihalyi',
    isbn: '9780061339202',
    published_year: 1990,
    pages: 336,
    category: 'philosophy-psychology',
    downloads: 16,
    description:
      'Explores the mental state of complete immersion when skill meets clear challenge, and explains how cultivating flow turns everyday work into intrinsic fulfillment.',
    topics: ['Anatomy of consciousness and attention', 'Conditions of the flow state', 'Balancing challenge and skill', 'Autotelic personality and work'],
  },
  {
    slug: 'influence-the-psychology-of-persuasion',
    title: 'Influence: The Psychology of Persuasion',
    author: 'Robert B. Cialdini',
    isbn: '9780062937650',
    published_year: 2021,
    pages: 592,
    category: 'philosophy-psychology',
    downloads: 18,
    description:
      'Examines the psychological triggers—reciprocity, commitment, social proof, authority, liking, scarcity and unity—that drive human compliance.',
    topics: ['Reciprocity and commitment consistency', 'Social proof and authority cues', 'Scarcity and urgency triggers', 'Defending against automatic compliance'],
  },
  {
    slug: 'the-psychology-of-money',
    title: 'The Psychology of Money',
    author: 'Morgan Housel',
    isbn: '9780857197689',
    published_year: 2020,
    pages: 256,
    category: 'economics-business',
    downloads: 23,
    description:
      'Timeless lessons on wealth, greed and happiness showing that financial success depends far more on behavior, patience and room for error than on complex spreadsheets.',
    topics: ['Compounding and the power of time', 'Getting wealthy versus staying wealthy', 'Tail events and room for error', 'Freedom as the highest dividend'],
  },
  {
    slug: 'the-lean-startup',
    title: 'The Lean Startup',
    author: 'Eric Ries',
    isbn: '9780307887894',
    published_year: 2011,
    pages: 336,
    category: 'economics-business',
    downloads: 17,
    description:
      'Introduces validated learning, minimum viable products and rapid Build-Measure-Learn feedback loops to help startups discover sustainable business models before running out of runway.',
    topics: ['Validated learning and hypotheses', 'Minimum viable products (MVP)', 'Innovation accounting and cohort metrics', 'When to pivot or persevere'],
  },
  {
    slug: 'good-to-great',
    title: 'Good to Great',
    author: 'Jim Collins',
    isbn: '9780066620992',
    published_year: 2001,
    pages: 320,
    category: 'economics-business',
    downloads: 13,
    description:
      'Analyzes what separates companies that make a sustained leap to superior performance—highlighting Level 5 leadership, the Hedgehog Concept and the flywheel effect.',
    topics: ['Level 5 leadership and humility', 'First who, then what', 'The Hedgehog Concept', 'Technology accelerators and the flywheel'],
  },
  {
    slug: 'thinking-in-systems',
    title: 'Thinking in Systems',
    author: 'Donella H. Meadows',
    isbn: '9781603580557',
    published_year: 2008,
    pages: 240,
    category: 'economics-business',
    downloads: 16,
    description:
      'A clear primer on stocks, flows, reinforcing and balancing feedback loops, system traps and high-leverage intervention points in economies and organizations.',
    topics: ['Stocks, flows and dynamic equilibrium', 'Reinforcing and balancing feedback loops', 'Common system archetypes and traps', 'Leverage points to intervene in a system'],
  },
  {
    slug: 'the-intelligent-investor',
    title: 'The Intelligent Investor',
    author: 'Benjamin Graham',
    isbn: '9780060555665',
    published_year: 1949,
    pages: 640,
    category: 'economics-business',
    downloads: 15,
    description:
      'The classic manual on value investing introducing Mr. Market, intrinsic value, defensive versus enterprising portfolios and the discipline of margin of safety.',
    topics: ['Investment versus speculation', 'Mr. Market and emotional discipline', 'Intrinsic value and security analysis', 'The margin of safety principle'],
  },
  {
    slug: 'how-to-solve-it',
    title: 'How to Solve It',
    author: 'George Pólya',
    isbn: '9780691164076',
    published_year: 1945,
    pages: 288,
    category: 'mathematics',
    downloads: 15,
    description:
      'Pólya\'s classic four-step heuristic framework—understand the problem, devise a plan, carry out the plan, look back—for tackling unfamiliar mathematical challenges.',
    topics: ['Understanding the problem clearly', 'Devising a plan using analogy and reduction', 'Carrying out and verifying each step', 'Looking back to generalize solutions'],
  },
  {
    slug: 'linear-algebra-done-right',
    title: 'Linear Algebra Done Right',
    author: 'Sheldon Axler',
    isbn: '9783319110790',
    published_year: 2015,
    pages: 340,
    category: 'mathematics',
    downloads: 13,
    description:
      'A clean, determinant-free development of finite-dimensional vector spaces, linear maps, eigenvalues, inner-product spaces and the spectral theorem.',
    topics: ['Vector spaces and linear maps', 'Eigenvalues and invariant subspaces', 'Inner-product spaces and orthogonality', 'The spectral theorem and singular values'],
  },
  {
    slug: 'concrete-mathematics',
    title: 'Concrete Mathematics: A Foundation for Computer Science',
    author: 'Ronald L. Graham, Donald E. Knuth & Oren Patashnik',
    isbn: '9780201558029',
    published_year: 1994,
    pages: 672,
    category: 'mathematics',
    downloads: 14,
    description:
      'Blends continuous and discrete mathematics for algorithm analysis—mastering recurrences, sums, integer functions, number theory, binomial coefficients and generating functions.',
    topics: ['Recurrent problems and sums', 'Integer functions and number theory', 'Binomial coefficients and identities', 'Generating functions and asymptotics'],
  },
  {
    slug: 'introduction-to-probability',
    title: 'Introduction to Probability',
    author: 'Joseph K. Blitzstein & Jessica Hwang',
    isbn: '9781138369917',
    published_year: 2019,
    pages: 634,
    category: 'mathematics',
    downloads: 16,
    description:
      'Builds intuitive mastery of probability through conditioning, story proofs, discrete and continuous distributions, expectation, limit theorems and Markov chains.',
    topics: ['Conditioning and Bayes\' rule', 'Random variables and distributions', 'Expectation, variance and inequalities', 'Law of large numbers and Markov chains'],
  },
  {
    slug: 'a-mathematicians-apology',
    title: 'A Mathematician\'s Apology',
    author: 'G. H. Hardy',
    isbn: '9781107604636',
    published_year: 1940,
    pages: 154,
    category: 'mathematics',
    downloads: 11,
    description:
      'G. H. Hardy\'s poignant essay defending pure mathematics as a creative art form akin to poetry and painting, illustrated with classic proofs by Euclid and Pythagoras.',
    topics: ['Mathematics as a creative art', 'Seriousness, depth and beauty in proofs', 'Pure versus applied mathematics', 'Classic proofs of Euclid and Pythagoras'],
  },
];

// Seed steps tracked in PRAGMA user_version; each runs once per database.
//   2 = expanded catalog (SEED_CATEGORIES / SEED_BOOKS additions)
//   4 = reader community + page-anchored study notes + community book requests & votes
const SEED_CATALOG_VERSION = 2;
const SEED_COMMUNITY_VERSION = 4;

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

function ensureDirectories() {
  for (const dir of [PUBLIC_DIR, UPLOADS_DIR, COVERS_DIR, BOOKS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Deterministic PRNG so the same title always produces the same cover. */
function createRng(seedText) {
  let h = 2166136261;
  for (let i = 0; i < seedText.length; i++) {
    h ^= seedText.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return function next() {
    h = (h + 0x6d2b79f5) | 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function slugify(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'book';
}

/** Format a Date like SQLite CURRENT_TIMESTAMP (UTC, 'YYYY-MM-DD HH:MM:SS'). */
function toSqlTimestamp(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function wrapText(text, maxChars) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    if (!current) {
      current = word;
    } else if ((current + ' ' + word).length <= maxChars) {
      current += ' ' + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const r1 = (n) => Math.round(n * 10) / 10;

/* ------------------------------------------------------------------ */
/* SVG cover generator                                                 */
/* ------------------------------------------------------------------ */

const PALETTES = {
  'computer-science': [
    { bg1: '#0f1c3f', bg2: '#1d3366', accent: '#f2b134', ink: '#fdf6e3', muted: '#9fb3d9' },
    { bg1: '#10263b', bg2: '#173d5c', accent: '#5eead4', ink: '#f0fdfa', muted: '#7fa6c4' },
  ],
  'software-architecture': [
    { bg1: '#0b3d3a', bg2: '#145c55', accent: '#ff7a59', ink: '#f4f1ea', muted: '#9cc9c1' },
    { bg1: '#1f2933', bg2: '#323f4b', accent: '#f5c84c', ink: '#f5f7fa', muted: '#9aa5b1' },
  ],
  'data-ai': [
    { bg1: '#2a0f4a', bg2: '#4b1d7a', accent: '#22d3ee', ink: '#f5f3ff', muted: '#c4b5fd' },
    { bg1: '#111827', bg2: '#1e1b4b', accent: '#f472b6', ink: '#fdf2f8', muted: '#a5b4fc' },
  ],
  'classic-literature': [
    { bg1: '#4a0f16', bg2: '#7a1e28', accent: '#e8c872', ink: '#fbf3e4', muted: '#d9a9a0' },
    { bg1: '#1d3b2a', bg2: '#2d5a40', accent: '#e9d8a6', ink: '#fbf7ec', muted: '#a7c4a0' },
  ],
  'science-physics': [
    { bg1: '#04152b', bg2: '#0b2f5b', accent: '#7dd3fc', ink: '#eef6ff', muted: '#93a9c9' },
    { bg1: '#1a1033', bg2: '#3b1f5e', accent: '#fb923c', ink: '#fff7ed', muted: '#c8b6e2' },
  ],
  'productivity-design': [
    { bg1: '#f3ede1', bg2: '#e6dccb', accent: '#e4572e', ink: '#1f2937', muted: '#7c6f5e' },
    { bg1: '#eef2ef', bg2: '#d9e4dd', accent: '#2f6f5e', ink: '#14241f', muted: '#6b8279' },
  ],
  'history-society': [
    { bg1: '#3b2a1a', bg2: '#5c4129', accent: '#f4a259', ink: '#fdf6ec', muted: '#c9ab8c' },
    { bg1: '#2b2d42', bg2: '#3d405b', accent: '#e07a5f', ink: '#f4f1de', muted: '#a5a8c4' },
  ],
  'philosophy-psychology': [
    { bg1: '#1f3a5f', bg2: '#2c5282', accent: '#f6e05e', ink: '#f7fafc', muted: '#a3bffa' },
    { bg1: '#f4efe9', bg2: '#e7ddd1', accent: '#6b4f9e', ink: '#231942', muted: '#8a7f9e' },
  ],
  'economics-business': [
    { bg1: '#0f3d2e', bg2: '#14532d', accent: '#facc15', ink: '#f7fee7', muted: '#86c5a0' },
    { bg1: '#18181b', bg2: '#27272a', accent: '#38bdf8', ink: '#fafafa', muted: '#a1a1aa' },
  ],
  mathematics: [
    { bg1: '#0c2340', bg2: '#123a66', accent: '#ff6b6b', ink: '#f8fbff', muted: '#8fb3de' },
    { bg1: '#fdf6e3', bg2: '#f1e6c8', accent: '#1d4ed8', ink: '#1e293b', muted: '#8b7d5c' },
  ],
};

const FALLBACK_PALETTES = [
  { bg1: '#1b1f3b', bg2: '#2e3466', accent: '#ffb347', ink: '#fdf8ef', muted: '#a3a9d6' },
  { bg1: '#3d0c11', bg2: '#5c1a22', accent: '#f6d186', ink: '#fff8ee', muted: '#d1a3a3' },
  { bg1: '#0d3b2e', bg2: '#16614b', accent: '#ffd166', ink: '#f2fbf6', muted: '#8fc7b1' },
  { bg1: '#f5efe6', bg2: '#e8dccb', accent: '#2a4d69', ink: '#1c2833', muted: '#7d6e5b' },
];

const ART_HEIGHT = 270;

const PATTERNS = {
  rings(p, rand) {
    const cx = r1(250 + rand() * 90);
    const cy = r1(90 + rand() * 70);
    let out = `<circle cx="${cx}" cy="${cy}" r="34" fill="${p.accent}"/>`;
    for (let i = 1; i <= 9; i++) {
      const opacity = r1((1 - i / 11) * 10) / 10;
      out += `<circle cx="${cx}" cy="${cy}" r="${34 + i * 22}" fill="none" stroke="${i % 3 === 0 ? p.accent : p.muted}" stroke-width="${i % 3 === 0 ? 3 : 1.5}" opacity="${opacity}"/>`;
    }
    return out;
  },
  dots(p, rand) {
    const phase = rand() * Math.PI * 2;
    let out = '';
    for (let y = 22; y < ART_HEIGHT - 10; y += 22) {
      for (let x = 22; x < 400; x += 22) {
        const r = r1(1.2 + 4.2 * Math.abs(Math.sin(x * 0.018 + y * 0.026 + phase)));
        const fill = (x + y) % 66 === 0 ? p.accent : p.muted;
        out += `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" opacity="0.85"/>`;
      }
    }
    return out;
  },
  stripes(p, rand) {
    const step = 16 + Math.floor(rand() * 8);
    let out = '';
    let i = 0;
    for (let x = -ART_HEIGHT; x < 400; x += step, i++) {
      const color = i % 4 === 0 ? p.accent : p.muted;
      const width = i % 4 === 0 ? 7 : 2;
      out += `<line x1="${x}" y1="${ART_HEIGHT}" x2="${x + ART_HEIGHT}" y2="0" stroke="${color}" stroke-width="${width}" opacity="${i % 4 === 0 ? 0.95 : 0.5}"/>`;
    }
    out += `<rect x="40" y="60" width="150" height="150" fill="${p.bg1}"/>`;
    out += `<rect x="40" y="60" width="150" height="150" fill="none" stroke="${p.accent}" stroke-width="3"/>`;
    return out;
  },
  triangles(p, rand) {
    const size = 50;
    const h = 44;
    let out = '';
    for (let row = 0; row * h < ART_HEIGHT; row++) {
      for (let col = -1; col * size < 420; col++) {
        const x = col * size + (row % 2 ? size / 2 : 0);
        const y = row * h;
        const roll = rand();
        if (roll < 0.25) continue;
        const fill = roll > 0.85 ? p.accent : p.muted;
        const opacity = roll > 0.85 ? 0.95 : r1(0.15 + roll * 0.4);
        const up = (row + col) % 2 === 0;
        const pts = up
          ? `${x},${y + h} ${x + size / 2},${y} ${x + size},${y + h}`
          : `${x},${y} ${x + size},${y} ${x + size / 2},${y + h}`;
        out += `<polygon points="${pts}" fill="${fill}" opacity="${opacity}"/>`;
      }
    }
    return out;
  },
  waves(p, rand) {
    const freq = 0.018 + rand() * 0.012;
    const phase = rand() * Math.PI * 2;
    let out = '';
    for (let i = 0; i < 12; i++) {
      const baseY = 24 + i * 20;
      const amp = 10 + i * 1.6;
      const pts = [];
      for (let x = 0; x <= 400; x += 8) {
        pts.push(`${x},${r1(baseY + Math.sin(x * freq + phase + i * 0.45) * amp)}`);
      }
      const color = i === 6 ? p.accent : p.muted;
      out += `<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="${i === 6 ? 4 : 1.6}" stroke-linecap="round" opacity="${i === 6 ? 1 : 0.6}"/>`;
    }
    return out;
  },
  bauhaus(p, rand) {
    const shift = Math.floor(rand() * 60);
    return [
      `<rect x="${40 + shift}" y="40" width="120" height="120" fill="${p.accent}"/>`,
      `<circle cx="${250 + shift / 2}" cy="120" r="80" fill="${p.muted}" opacity="0.55"/>`,
      `<path d="M ${300 - shift} 270 A 100 100 0 0 1 400 170 L 400 270 Z" fill="${p.accent}" opacity="0.85"/>`,
      `<rect x="0" y="200" width="${200 + shift}" height="12" fill="${p.ink}" opacity="0.85"/>`,
      `<path d="M 0 0 L 90 0 A 90 90 0 0 1 0 90 Z" fill="${p.muted}" opacity="0.4"/>`,
      `<circle cx="${320 - shift}" cy="50" r="14" fill="${p.ink}" opacity="0.9"/>`,
    ].join('');
  },
};

const PATTERN_NAMES = Object.keys(PATTERNS);

function generateCoverSvg({ title, author, categoryName, categorySlug, variant }) {
  const seedKey = `${title}|${author}`;
  const hash = hashString(seedKey);
  const v = Number.isInteger(variant) ? variant : hash;
  const family = PALETTES[categorySlug];
  const palette = family ? family[v % family.length] : FALLBACK_PALETTES[hash % FALLBACK_PALETTES.length];
  const patternName = PATTERN_NAMES[(Number.isInteger(variant) ? variant : hash) % PATTERN_NAMES.length];
  const rand = createRng(seedKey);
  const art = PATTERNS[patternName](palette, rand);

  let authorLines = wrapText(author, 34);
  if (authorLines.length > 2) {
    const first = String(author).split(/\s*(?:,|&|\band\b)\s*/)[0];
    authorLines = wrapText(`${first} et al.`, 34).slice(0, 2);
  }
  const ruleY = authorLines.length === 2 ? 498 : 518;

  let lines = wrapText(title, 14);
  if (lines.length > 4) lines = wrapText(title, 19);
  if (lines.length > 4) lines = wrapText(title, 26);
  if (lines.length > 5) lines = [...lines.slice(0, 4), lines.slice(4).join(' ').slice(0, 23) + '...'];
  const longest = Math.max(...lines.map((l) => l.length));
  let fontSize = Math.min(48, Math.floor(320 / (longest * 0.56)));
  fontSize = Math.min(fontSize, Math.floor((ruleY - 20 - 338) / (1 + (lines.length - 1) * 1.12)));
  fontSize = Math.max(fontSize, 20);
  const lineHeight = Math.round(fontSize * 1.12);
  const titleStartY = 338 + fontSize;

  const titleSpans = lines
    .map((line, i) => `<tspan x="40" y="${titleStartY + i * lineHeight}">${escapeXml(line)}</tspan>`)
    .join('');

  const authorSpans = authorLines
    .map((line, i) => `<tspan x="40" y="${authorLines.length === 2 ? 530 + i * 22 : 548}">${escapeXml(line)}</tspan>`)
    .join('');

  const label = escapeXml(String(categoryName || 'Booknest Library').toUpperCase());

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600" role="img" aria-label="${escapeXml(title)} by ${escapeXml(author)}">
  <title>${escapeXml(title)} - ${escapeXml(author)}</title>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="${palette.bg1}"/>
      <stop offset="1" stop-color="${palette.bg2}"/>
    </linearGradient>
    <linearGradient id="spine" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#000000" stop-opacity="0.38"/>
      <stop offset="0.6" stop-color="#000000" stop-opacity="0.08"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0.12"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.10"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="art"><rect x="0" y="0" width="400" height="${ART_HEIGHT}"/></clipPath>
  </defs>
  <rect width="400" height="600" fill="url(#bg)"/>
  <g clip-path="url(#art)">${art}</g>
  <rect x="0" y="${ART_HEIGHT}" width="400" height="4" fill="${palette.accent}"/>
  <text x="40" y="316" font-family="Helvetica, Arial, sans-serif" font-size="12" font-weight="700" letter-spacing="3" fill="${palette.accent}">${label}</text>
  <text font-family="Georgia, 'Times New Roman', serif" font-size="${fontSize}" font-weight="700" fill="${palette.ink}">${titleSpans}</text>
  <rect x="40" y="${ruleY}" width="48" height="3" fill="${palette.accent}"/>
  <text font-family="Helvetica, Arial, sans-serif" font-size="17" letter-spacing="0.5" fill="${palette.ink}" opacity="0.88">${authorSpans}</text>
  <text x="40" y="578" font-family="Helvetica, Arial, sans-serif" font-size="9" font-weight="700" letter-spacing="4" fill="${palette.muted}">BOOKNEST EDITIONS</text>
  <rect width="400" height="600" fill="url(#sheen)"/>
  <rect x="0" y="0" width="22" height="600" fill="url(#spine)"/>
  <rect x="22" y="0" width="1" height="600" fill="#ffffff" opacity="0.12"/>
</svg>
`;
}

/* ------------------------------------------------------------------ */
/* PDF generator (PDF 1.4, built byte-by-byte with a correct xref)     */
/* ------------------------------------------------------------------ */

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 72;

function toAscii(text) {
  return String(text)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '');
}

function pdfString(text) {
  return '(' + toAscii(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)') + ')';
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map((c) => c.toFixed(3)).join(' ');
}

const FONT_WIDTH = { F1: 0.5, F2: 0.56, F3: 0.5 };

function textOp(x, y, font, size, text, color = '0.12 0.12 0.14') {
  return `BT ${color} rg /${font} ${size} Tf ${r1(x)} ${r1(y)} Td ${pdfString(text)} Tj ET`;
}

function centeredTextOp(y, font, size, text, color) {
  const width = toAscii(text).length * size * FONT_WIDTH[font];
  return textOp(Math.max(MARGIN / 2, (PAGE_W - width) / 2), y, font, size, text, color);
}

function rectOp(x, y, w, h, rgb) {
  return `${rgb} rg ${r1(x)} ${r1(y)} ${r1(w)} ${r1(h)} re f`;
}

function lineOp(x1, y1, x2, y2, rgb, width = 1) {
  return `${rgb} RG ${width} w ${r1(x1)} ${r1(y1)} m ${r1(x2)} ${r1(y2)} l S`;
}

function chapterBlocks(book) {
  const { title, author, published_year, categoryName, description, topics } = book;
  const year = published_year || 'its year of publication';
  return [
    {
      heading: 'Chapter 1. Overview',
      blocks: [
        { type: 'para', text: description },
        {
          type: 'para',
          text: `${title}, written by ${author} and first published in ${year}, is widely regarded as an essential work in the field of ${categoryName}. This Booknest study edition summarizes its central arguments, highlights the ideas that have influenced generations of readers, and offers structured notes for review and discussion.`,
        },
        {
          type: 'para',
          text: 'Readers approaching the book for the first time should pay attention to how each part builds on the previous one. The author introduces a small number of core concepts early and returns to them repeatedly, each time from a more demanding perspective. Keeping a short glossary while reading makes the later material considerably easier to absorb.',
        },
        { type: 'subhead', text: 'How to use this edition' },
        {
          type: 'para',
          text: 'Each chapter of this study edition corresponds to a major theme of the original work. Read the summary first, then revisit the relevant sections of the full text, and finally attempt the discussion questions in Chapter 3 without referring back to your notes.',
        },
      ],
    },
    {
      heading: 'Chapter 2. Key Ideas',
      blocks: topics.flatMap((topic, i) => [
        { type: 'subhead', text: `${i + 1}. ${topic}` },
        {
          type: 'para',
          text: `The theme of "${topic.toLowerCase()}" is one of the pillars of ${title}. ${author} develops it carefully, first through motivating examples and then through a more general treatment that reveals why it matters. The discussion connects this theme to the others in the book, showing that it is not an isolated topic but part of a coherent way of thinking.`,
        },
        {
          type: 'para',
          text: `When studying this section, try to restate the main argument in your own words and identify one concrete situation in which it applies. Comparing the author's position with alternative viewpoints in ${categoryName} is an effective way to understand both its strengths and its limitations.`,
        },
      ]),
    },
    {
      heading: 'Chapter 3. Study Notes and Discussion',
      blocks: [
        {
          type: 'para',
          text: `The following questions are designed for seminars, reading groups and self-study. They move from comprehension toward critical evaluation, and many have no single correct answer. Strong responses cite specific passages from ${title} and connect them to wider debates in ${categoryName}.`,
        },
        ...topics.map((topic, i) => ({
          type: 'para',
          text: `Q${i + 1}. How does the author's treatment of ${topic.toLowerCase()} change the way you would approach a real problem in this area? Give an example, and explain what you would have done differently before reading the book.`,
        })),
        { type: 'subhead', text: 'Summary' },
        {
          type: 'para',
          text: `${title} rewards careful, repeated reading. Its lasting value comes not only from the specific facts or techniques it presents, but from the habits of thought it cultivates. Return to these notes after finishing the full text and reflect on which ideas have become part of your own toolkit.`,
        },
      ],
    },
  ];
}

function layoutChapter(chapter, runningTitle) {
  const pages = [];
  let ops = [];
  let y = PAGE_H - MARGIN - 40;
  const bodySize = 11;
  const leading = 16;
  const maxChars = 84;

  const newPage = () => {
    pages.push(ops);
    ops = [];
    y = PAGE_H - MARGIN - 20;
  };

  ops.push(textOp(MARGIN, y, 'F2', 22, chapter.heading));
  y -= 14;
  ops.push(lineOp(MARGIN, y, MARGIN + 60, y, '0.80 0.36 0.20', 2));
  y -= 30;

  for (const block of chapter.blocks) {
    if (block.type === 'subhead') {
      if (y < MARGIN + 60) newPage();
      y -= 6;
      ops.push(textOp(MARGIN, y, 'F2', 13, block.text));
      y -= 22;
    } else {
      const lines = wrapText(toAscii(block.text), maxChars);
      for (const line of lines) {
        if (y < MARGIN + 10) newPage();
        ops.push(textOp(MARGIN, y, 'F1', bodySize, line));
        y -= leading;
      }
      y -= 10;
    }
  }
  pages.push(ops);
  return pages.map((p) => ({ ops: p, runningTitle }));
}

function generateBookPdf(book) {
  const palette = (PALETTES[book.categorySlug] || FALLBACK_PALETTES)[0];
  const accent = hexToRgb(palette.accent);
  const dark = hexToRgb(palette.bg1);
  const ink = hexToRgb(palette.ink);

  const FRONT_MATTER_PAGES = 3;
  const chapters = chapterBlocks(book);
  const chapterPages = [];
  const toc = [];
  for (const chapter of chapters) {
    toc.push({ heading: chapter.heading, page: FRONT_MATTER_PAGES + chapterPages.length + 1 });
    chapterPages.push(...layoutChapter(chapter, book.title));
  }

  // Page 1: title page
  const titleOps = [rectOp(0, PAGE_H - 300, PAGE_W, 300, dark), rectOp(0, PAGE_H - 306, PAGE_W, 6, accent)];
  titleOps.push(centeredTextOp(PAGE_H - 90, 'F2', 11, String(book.categoryName).toUpperCase(), accent));
  const titleLines = wrapText(toAscii(book.title), 30).slice(0, 4);
  const titleSize = titleLines.length > 2 ? 24 : 30;
  titleLines.forEach((line, i) => {
    titleOps.push(centeredTextOp(PAGE_H - 150 - i * (titleSize + 8), 'F2', titleSize, line, ink));
  });
  wrapText(toAscii(book.author), 60).slice(0, 2).forEach((line, i) => {
    titleOps.push(centeredTextOp(PAGE_H - 380 - i * 20, 'F1', 15, line));
  });
  titleOps.push(centeredTextOp(PAGE_H - 440, 'F3', 11, 'Booknest Study Edition', '0.40 0.40 0.45'));
  titleOps.push(lineOp(PAGE_W / 2 - 40, 110, PAGE_W / 2 + 40, 110, accent, 1.5));
  titleOps.push(centeredTextOp(88, 'F2', 10, 'B O O K N E S T   E D I T I O N S', '0.40 0.40 0.45'));

  // Page 2: colophon / bibliographic record
  const infoOps = [textOp(MARGIN, PAGE_H - MARGIN - 40, 'F2', 18, 'Bibliographic Record')];
  infoOps.push(lineOp(MARGIN, PAGE_H - MARGIN - 54, PAGE_W - MARGIN, PAGE_H - MARGIN - 54, '0.80 0.80 0.82', 1));
  const meta = [
    ['Title', book.title],
    ['Author', book.author],
    ['Category', book.categoryName],
    ['First published', book.published_year ? String(book.published_year) : 'Unknown'],
    ['Print length', book.pages ? `${book.pages} pages` : 'Unknown'],
    ['ISBN', book.isbn || 'Not assigned'],
  ];
  let my = PAGE_H - MARGIN - 86;
  for (const [label, value] of meta) {
    infoOps.push(textOp(MARGIN, my, 'F2', 11, label));
    const valueLines = wrapText(toAscii(value), 58);
    valueLines.forEach((line, i) => infoOps.push(textOp(MARGIN + 120, my - i * 15, 'F1', 11, line)));
    my -= 15 * valueLines.length + 10;
  }
  my -= 20;
  const notice =
    'This Booknest study edition contains an original synopsis, thematic notes and discussion questions. It is a companion to the original work and does not reproduce its text.';
  wrapText(notice, 84).forEach((line) => {
    infoOps.push(textOp(MARGIN, my, 'F3', 10, line, '0.35 0.35 0.40'));
    my -= 14;
  });

  // Page 3: table of contents
  const tocOps = [textOp(MARGIN, PAGE_H - MARGIN - 40, 'F2', 22, 'Contents')];
  tocOps.push(lineOp(MARGIN, PAGE_H - MARGIN - 54, MARGIN + 60, PAGE_H - MARGIN - 54, accent, 2));
  let ty = PAGE_H - MARGIN - 100;
  for (const entry of toc) {
    tocOps.push(textOp(MARGIN, ty, 'F1', 12, entry.heading));
    const headingWidth = toAscii(entry.heading).length * 12 * FONT_WIDTH.F1;
    tocOps.push(`[2 3] 0 d ${lineOp(MARGIN + headingWidth + 8, ty + 3, PAGE_W - MARGIN - 28, ty + 3, '0.65 0.65 0.68', 0.8)} [] 0 d`);
    tocOps.push(textOp(PAGE_W - MARGIN - 18, ty, 'F2', 12, String(entry.page)));
    ty -= 28;
  }

  const allPages = [
    { ops: titleOps, runningTitle: null },
    { ops: infoOps, runningTitle: book.title },
    { ops: tocOps, runningTitle: book.title },
    ...chapterPages,
  ];

  allPages.forEach((page, i) => {
    if (!page.runningTitle) return;
    const header = toAscii(page.runningTitle).slice(0, 70);
    page.ops.push(textOp(MARGIN, PAGE_H - 40, 'F3', 9, header, '0.50 0.50 0.55'));
    page.ops.push(lineOp(MARGIN, PAGE_H - 48, PAGE_W - MARGIN, PAGE_H - 48, '0.85 0.85 0.87', 0.6));
    page.ops.push(centeredTextOp(40, 'F1', 9, String(i + 1), '0.50 0.50 0.55'));
  });

  const objects = [];
  const pageObjNums = allPages.map((_, i) => 7 + i * 2);
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${allPages.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>');
  objects.push(
    `<< /Title ${pdfString(book.title)} /Author ${pdfString(book.author)} /Subject ${pdfString(book.categoryName)} /Creator (Booknest Seeder) /Producer (Booknest) >>`
  );
  for (let i = 0; i < allPages.length; i++) {
    const contentNum = pageObjNums[i] + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${contentNum} 0 R >>`
    );
    const stream = allPages[i].ops.join('\n');
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  }

  let out = '%PDF-1.4\n%\u00E2\u00E3\u00CF\u00D3\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/* ------------------------------------------------------------------ */
/* Seeding                                                             */
/* ------------------------------------------------------------------ */

function seedAssetPaths(slug) {
  return {
    cover_path: `/uploads/covers/seed-${slug}.svg`,
    file_path: `/uploads/books/seed-${slug}.pdf`,
  };
}

function webPathToDisk(webPath) {
  return path.join(PUBLIC_DIR, ...webPath.split('/').filter(Boolean));
}

function writeSeedAssets(book, index, category) {
  const { cover_path, file_path } = seedAssetPaths(book.slug);
  const svg = generateCoverSvg({
    title: book.title,
    author: book.author,
    categoryName: category.category_name,
    categorySlug: category.slug,
    variant: index,
  });
  fs.writeFileSync(webPathToDisk(cover_path), svg, 'utf8');
  const pdf = generateBookPdf({ ...book, categoryName: category.category_name, categorySlug: category.slug });
  fs.writeFileSync(webPathToDisk(file_path), pdf);
}

/** Seed the admin account, categories and books if no users exist. */
function seedIfEmpty(db) {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM Users').get();
  if (count > 0) return false;

  ensureDirectories();
  const categoryBySlug = Object.fromEntries(SEED_CATEGORIES.map((c) => [c.slug, c]));

  SEED_BOOKS.forEach((book, i) => writeSeedAssets(book, i, categoryBySlug[book.category]));

  const insertUser = db.prepare(
    'INSERT INTO Users (full_name, username, email, password_hash, role) VALUES (?, ?, ?, ?, ?)'
  );
  const insertCategory = db.prepare('INSERT INTO Categories (category_name, slug, description) VALUES (?, ?, ?)');
  const insertBook = db.prepare(
    `INSERT INTO Books (title, author, isbn, published_year, pages, description, cover_path, file_path, category_id, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const run = db.transaction(() => {
    for (const u of SEED_USERS) {
      insertUser.run(u.full_name, u.username, u.email, bcrypt.hashSync(u.password, 10), u.role);
    }

    const categoryIds = {};
    for (const c of SEED_CATEGORIES) {
      categoryIds[c.slug] = Number(insertCategory.run(c.category_name, c.slug, c.description).lastInsertRowid);
    }

    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;

    SEED_BOOKS.forEach((b, i) => {
      const { cover_path, file_path } = seedAssetPaths(b.slug);
      const uploadedAt = new Date(now - (SEED_BOOKS.length - i) * 3 * DAY - 2 * DAY);
      insertBook.run(
        b.title,
        b.author,
        b.isbn,
        b.published_year,
        b.pages,
        b.description,
        cover_path,
        file_path,
        categoryIds[b.category],
        toSqlTimestamp(uploadedAt)
      );
    });
  });

  run();
  return true;
}

/** Regenerate seed covers/PDFs that are referenced in the DB but missing on disk. */
function restoreSeedAssets(db) {
  ensureDirectories();
  const categoryBySlug = Object.fromEntries(SEED_CATEGORIES.map((c) => [c.slug, c]));
  const exists = db.prepare('SELECT 1 FROM Books WHERE file_path = ? OR cover_path = ?');
  let restored = 0;
  SEED_BOOKS.forEach((book, i) => {
    const { cover_path, file_path } = seedAssetPaths(book.slug);
    if (!exists.get(file_path, cover_path)) return;
    if (!fs.existsSync(webPathToDisk(cover_path)) || !fs.existsSync(webPathToDisk(file_path))) {
      writeSeedAssets(book, i, categoryBySlug[book.category]);
      restored++;
    }
  });
  return restored;
}

/* ------------------------------------------------------------------ */
/* sql.js database wrapper                                             */
/* ------------------------------------------------------------------ */

let sqlJsModulePromise = null;
function loadSqlJs() {
  if (!sqlJsModulePromise) sqlJsModulePromise = initSqlJs();
  return sqlJsModulePromise;
}

function tagSqliteError(err) {
  const msg = String(err && err.message);
  if (/UNIQUE constraint failed/i.test(msg)) err.code = 'SQLITE_CONSTRAINT_UNIQUE';
  else if (/FOREIGN KEY constraint failed/i.test(msg)) err.code = 'SQLITE_CONSTRAINT_FOREIGNKEY';
  else if (/CHECK constraint failed/i.test(msg)) err.code = 'SQLITE_CONSTRAINT_CHECK';
  else if (/NOT NULL constraint failed/i.test(msg)) err.code = 'SQLITE_CONSTRAINT_NOTNULL';
  else if (/constraint failed/i.test(msg)) err.code = 'SQLITE_CONSTRAINT';
  return err;
}

function normalizeParams(params) {
  return params.map((v) => {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'bigint') return Number(v);
    return v;
  });
}

class SqlJsStatement {
  constructor(database, sqlText) {
    this.database = database;
    this.sqlText = sqlText;
  }

  _withStatement(params, fn) {
    const stmt = this.database.raw.prepare(this.sqlText);
    try {
      stmt.bind(normalizeParams(params));
      return fn(stmt);
    } catch (err) {
      throw tagSqliteError(err);
    } finally {
      stmt.free();
    }
  }

  all(...params) {
    return this._withStatement(params, (stmt) => {
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    });
  }

  get(...params) {
    return this._withStatement(params, (stmt) => (stmt.step() ? stmt.getAsObject() : undefined));
  }

  run(...params) {
    const raw = this.database.raw;
    const result = this._withStatement(params, (stmt) => {
      stmt.step();
      return {
        changes: raw.getRowsModified(),
        lastInsertRowid: raw.exec('SELECT last_insert_rowid() AS id')[0].values[0][0],
      };
    });
    this.database.persist();
    return result;
  }
}

class SqlJsDatabase {
  constructor(filePath = DEFAULT_DB_PATH) {
    this.filePath = filePath;
    this.raw = null;
    this.txDepth = 0;
    this.dirty = false;
  }

  async open() {
    if (this.raw) return this;
    const SQL = await loadSqlJs();
    this.raw = fs.existsSync(this.filePath)
      ? new SQL.Database(new Uint8Array(fs.readFileSync(this.filePath)))
      : new SQL.Database();
    this._configureConnection();
    return this;
  }

  _configureConnection() {
    this.raw.run('PRAGMA foreign_keys = ON;');
  }

  _requireOpen() {
    if (!this.raw) throw new Error('Database is not open yet. Call await initDatabase() first.');
  }

  prepare(sqlText) {
    return new SqlJsStatement(this, sqlText);
  }

  exec(sqlText) {
    this._requireOpen();
    try {
      this.raw.exec(sqlText);
    } catch (err) {
      throw tagSqliteError(err);
    }
    this.persist();
  }

  persist() {
    this._requireOpen();
    if (this.txDepth > 0) {
      this.dirty = true;
      return;
    }
    const data = this.raw.export();
    this._configureConnection();
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, Buffer.from(data));
    fs.renameSync(tmpPath, this.filePath);
    this.dirty = false;
  }

  transaction(fn) {
    return (...args) => {
      this._requireOpen();
      if (this.txDepth > 0) return fn(...args);
      this.raw.run('BEGIN TRANSACTION;');
      this.txDepth = 1;
      let result;
      try {
        result = fn(...args);
        this.raw.run('COMMIT;');
      } catch (err) {
        try {
          this.raw.run('ROLLBACK;');
        } catch (rollbackErr) {
          // SQLite may already have rolled back
        }
        this.txDepth = 0;
        this.dirty = false;
        throw err;
      }
      this.txDepth = 0;
      if (this.dirty) this.persist();
      return result;
    };
  }

  close() {
    if (!this.raw) return;
    if (this.dirty) this.persist();
    this.raw.close();
    this.raw = null;
  }
}

function createDatabase(dbPath = DEFAULT_DB_PATH) {
  return new SqlJsDatabase(dbPath);
}

async function initDatabase(db = createDatabase()) {
  ensureDirectories();
  await db.open();
  migrateBeforeSchema(db);
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const seeded = seedIfEmpty(db);
  syncSeedCatalog(db);
  seedCommunity(db);
  const restored = restoreSeedAssets(db);
  return { db, seeded, restored };
}

function migrateBeforeSchema(db) {
  const hasBooks = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'Books'").get();
  if (!hasBooks) return;
  const columns = db.prepare('PRAGMA table_info(Books)').all().map((c) => c.name);
  if (!columns.includes('avg_rating')) db.exec('ALTER TABLE Books ADD COLUMN avg_rating REAL DEFAULT 0;');
  if (!columns.includes('review_count')) db.exec('ALTER TABLE Books ADD COLUMN review_count INTEGER DEFAULT 0;');
}

function countPdfPages(absPath) {
  try {
    const text = fs.readFileSync(absPath).toString('latin1');
    return (text.match(/\/Type\s*\/Page(?![A-Za-z])/g) || []).length;
  } catch (err) {
    return 0;
  }
}

function syncSeedCatalog(db) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  if (current >= SEED_CATALOG_VERSION) return 0;

  const categoryBySlug = Object.fromEntries(SEED_CATEGORIES.map((c) => [c.slug, c]));
  const findCategory = db.prepare('SELECT category_id FROM Categories WHERE slug = ?');
  const insertCategory = db.prepare('INSERT INTO Categories (category_name, slug, description) VALUES (?, ?, ?)');
  const findBook = db.prepare('SELECT book_id FROM Books WHERE isbn = ? OR file_path = ?');
  const insertBook = db.prepare(
    `INSERT INTO Books (title, author, isbn, published_year, pages, description, cover_path, file_path, category_id, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const missingBooks = SEED_BOOKS.map((book, index) => ({ book, index })).filter(
    ({ book }) => !findBook.get(book.isbn, seedAssetPaths(book.slug).file_path)
  );
  missingBooks.forEach(({ book, index }) => writeSeedAssets(book, index, categoryBySlug[book.category]));

  const run = db.transaction(() => {
    for (const c of SEED_CATEGORIES) {
      if (!findCategory.get(c.slug)) insertCategory.run(c.category_name, c.slug, c.description);
    }
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    missingBooks.forEach(({ book: b }, i) => {
      const { cover_path, file_path } = seedAssetPaths(b.slug);
      const uploadedAt = new Date(now - (missingBooks.length - i) * 0.75 * DAY - DAY);
      insertBook.run(
        b.title,
        b.author,
        b.isbn,
        b.published_year,
        b.pages,
        b.description,
        cover_path,
        file_path,
        findCategory.get(b.category).category_id,
        toSqlTimestamp(uploadedAt)
      );
    });
  });
  run();
  db.exec(`PRAGMA user_version = ${SEED_CATALOG_VERSION};`);
  return missingBooks.length;
}

/**
 * Seeds the sample reader community once: reader accounts, downloads biased by
 * each reader's favorite categories, verified reviews, reading progress,
 * page-anchored study notes, bookmarks, community book requests, and audit history.
 */
function seedCommunity(db) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  if (current >= SEED_COMMUNITY_VERSION) return 0;

  const rand = createRng(`booknest-community-v${SEED_COMMUNITY_VERSION}`);
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const parseTs = (ts) => new Date(String(ts).replace(' ', 'T') + 'Z').getTime();

  const findByEmail = db.prepare('SELECT user_id, created_at FROM Users WHERE LOWER(email) = LOWER(?)');
  const findByUsername = db.prepare('SELECT user_id FROM Users WHERE LOWER(username) = LOWER(?)');
  const insertUser = db.prepare(
    "INSERT INTO Users (full_name, username, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'user', ?)"
  );
  const insertDownload = db.prepare('INSERT INTO Downloads (user_id, book_id, downloaded_at) VALUES (?, ?, ?)');
  const insertReview = db.prepare(
    'INSERT OR IGNORE INTO Reviews (user_id, book_id, rating, comment, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  const insertProgress = db.prepare(
    'INSERT OR IGNORE INTO Reading_Progress (user_id, book_id, current_page, total_pages, updated_at) VALUES (?, ?, ?, ?, ?)'
  );
  const insertBookmark = db.prepare('INSERT OR IGNORE INTO Bookmarks (user_id, book_id, created_at) VALUES (?, ?, ?)');
  const insertNote = db.prepare(
    'INSERT INTO Reading_Notes (user_id, book_id, page_number, note_text, is_public, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertRequest = db.prepare(
    'INSERT INTO Book_Requests (user_id, title, author, isbn, reason, status, fulfilled_book_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertVote = db.prepare('INSERT OR IGNORE INTO Request_Votes (user_id, request_id, voted_at) VALUES (?, ?, ?)');
  const bookByIsbn = db.prepare('SELECT book_id, uploaded_at, file_path FROM Books WHERE isbn = ?');

  const hash = bcrypt.hashSync(SEED_READER_PASSWORD, 10);
  const pageCache = new Map();
  const pdfPages = (webPath) => {
    if (!pageCache.has(webPath)) pageCache.set(webPath, countPdfPages(webPathToDisk(webPath)) || 1);
    return pageCache.get(webPath);
  };
  const pick = (items, weights) => {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = rand() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  };

  const run = db.transaction(() => {
    const readers = [];
    SEED_READERS.forEach((r, i) => {
      const existing = findByEmail.get(r.email);
      if (existing) {
        readers.push({ ...r, id: existing.user_id, createdAt: parseTs(existing.created_at) });
        return;
      }
      if (findByUsername.get(r.username)) return;
      const createdAt = now - (75 - i * 4) * DAY;
      const id = Number(insertUser.run(r.full_name, r.username, r.email, hash, toSqlTimestamp(new Date(createdAt))).lastInsertRowid);
      readers.push({ ...r, id, createdAt });
    });
    if (!readers.length) return;

    const pairs = new Map();
    for (const seed of SEED_BOOKS) {
      const book = bookByIsbn.get(seed.isbn);
      if (!book) continue;
      const weights = readers.map((r) => (r.favorites.includes(seed.category) ? 6 : 1));
      for (let d = 0; d < seed.downloads; d++) {
        const reader = pick(readers, weights);
        const start = Math.max(parseTs(book.uploaded_at), reader.createdAt);
        const at = start + rand() * Math.max(0, now - start);
        insertDownload.run(reader.id, book.book_id, toSqlTimestamp(new Date(at)));
        const key = `${reader.id}:${book.book_id}`;
        const pair = pairs.get(key);
        if (!pair) pairs.set(key, { reader, book, seed, firstAt: at });
        else pair.firstAt = Math.min(pair.firstAt, at);
      }
    }

    const sampleSnippets = [
      'Key takeaway: separate core invariants from I/O boundaries early.',
      'Compare how indexing trade-offs affect write amplification versus read latency.',
      'Revisit this chapter before exam week - great summary of core trade-offs.',
      'Notice how first principles simplify the edge cases discussed later.',
    ];

    for (const { reader, book, seed, firstAt } of pairs.values()) {
      const favorite = reader.favorites.includes(seed.category);
      const later = (fraction) => toSqlTimestamp(new Date(firstAt + rand() * fraction * Math.max(0, now - firstAt)));
      if (rand() < (favorite ? 0.6 : 0.3)) {
        const rating = favorite ? (rand() < 0.65 ? 5 : 4) : [3, 4, 4, 5, 2][Math.floor(rand() * 5)];
        const options = REVIEW_COMMENTS[rating];
        insertReview.run(reader.id, book.book_id, rating, options[Math.floor(rand() * options.length)], later(0.6));
      }
      if (rand() < 0.45) {
        const total = pdfPages(book.file_path);
        const curPage = 1 + Math.floor(rand() * total);
        insertProgress.run(reader.id, book.book_id, curPage, total, later(1));
        if (rand() < 0.5) {
          insertNote.run(
            reader.id,
            book.book_id,
            curPage,
            sampleSnippets[Math.floor(rand() * sampleSnippets.length)],
            rand() < 0.7 ? 1 : 0,
            later(1)
          );
        }
      }
      if (rand() < 0.18) insertBookmark.run(reader.id, book.book_id, later(1));
    }

    // Seed community book requests & votes if empty
    const reqCount = db.prepare('SELECT COUNT(*) AS n FROM Book_Requests').get().n;
    if (reqCount === 0 && readers.length >= 4) {
      const ddia = bookByIsbn.get('9781449373320');
      const sampleRequests = [
        {
          user: readers[2],
          title: 'Introduction to the Theory of Computation',
          author: 'Michael Sipser',
          isbn: '9781133187790',
          reason: 'Essential reference for automata theory, computability, and NP-completeness proofs.',
          status: 'open',
          fulfilled_book_id: null,
          voters: [readers[0], readers[2], readers[4], readers[6]],
        },
        {
          user: readers[0],
          title: 'Computer Organization and Design',
          author: 'David A. Patterson & John L. Hennessy',
          isbn: '9780128201091',
          reason: 'Core RISC-V architecture, pipelining, and memory hierarchy textbook.',
          status: 'open',
          fulfilled_book_id: null,
          voters: [readers[0], readers[2], readers[4]],
        },
        {
          user: readers[3],
          title: 'Principles of Distributed Database Systems',
          author: 'M. Tamer Özsu & Patrick Valduriez',
          isbn: '9783030262525',
          reason: 'Deep dive into distributed query processing, replication, and consensus.',
          status: 'open',
          fulfilled_book_id: null,
          voters: [readers[1], readers[3]],
        },
        {
          user: readers[4],
          title: 'Designing Data-Intensive Applications',
          author: 'Martin Kleppmann',
          isbn: '9781449373320',
          reason: 'Requested for distributed replication and storage engine deep dives.',
          status: ddia ? 'fulfilled' : 'open',
          fulfilled_book_id: ddia ? ddia.book_id : null,
          voters: [readers[0], readers[2], readers[4], readers[5], readers[6]],
        },
      ];

      sampleRequests.forEach((reqItem, idx) => {
        const createdAt = toSqlTimestamp(new Date(now - (12 - idx * 2) * DAY));
        const reqId = Number(
          insertRequest.run(
            reqItem.user.id,
            reqItem.title,
            reqItem.author,
            reqItem.isbn,
            reqItem.reason,
            reqItem.status,
            reqItem.fulfilled_book_id,
            createdAt
          ).lastInsertRowid
        );
        reqItem.voters.forEach((v) => insertVote.run(v.id, reqId, createdAt));
      });
    }

    // Audit history for rows created before the audit triggers existed.
    db.prepare(
      `INSERT INTO Audit_Logs (action_type, entity_type, entity_id, details, created_at)
       SELECT 'INSERT', 'Book', b.book_id, 'Added "' || b.title || '" by ' || b.author, b.uploaded_at
       FROM Books b
       WHERE NOT EXISTS (SELECT 1 FROM Audit_Logs a WHERE a.entity_type = 'Book' AND a.action_type = 'INSERT' AND a.entity_id = b.book_id)`
    ).run();
    db.prepare(
      `INSERT INTO Audit_Logs (action_type, entity_type, entity_id, details, created_at)
       SELECT 'INSERT', 'User', u.user_id, 'New ' || u.role || ' account @' || u.username, u.created_at
       FROM Users u
       WHERE NOT EXISTS (SELECT 1 FROM Audit_Logs a WHERE a.entity_type = 'User' AND a.action_type = 'INSERT' AND a.entity_id = u.user_id)`
    ).run();
    db.prepare(
      `UPDATE Audit_Logs SET created_at = (SELECT b.uploaded_at FROM Books b WHERE b.book_id = Audit_Logs.entity_id)
       WHERE entity_type = 'Book' AND action_type = 'INSERT' AND entity_id IN (SELECT book_id FROM Books)`
    ).run();
    db.prepare(
      `UPDATE Audit_Logs SET created_at = (SELECT u.created_at FROM Users u WHERE u.user_id = Audit_Logs.entity_id)
       WHERE entity_type = 'User' AND action_type = 'INSERT' AND entity_id IN (SELECT user_id FROM Users)`
    ).run();
  });
  run();
  db.exec(`PRAGMA user_version = ${SEED_COMMUNITY_VERSION};`);
  return 1;
}

function resetEverything(dbPath = DEFAULT_DB_PATH) {
  for (const suffix of ['', '.tmp', '-wal', '-shm']) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
  fs.rmSync(UPLOADS_DIR, { recursive: true, force: true });
}

module.exports = {
  createDatabase,
  initDatabase,
  SqlJsDatabase,
  seedIfEmpty,
  restoreSeedAssets,
  generateCoverSvg,
  generateBookPdf,
  countPdfPages,
  slugify,
  ensureDirectories,
  PUBLIC_DIR,
  UPLOADS_DIR,
  COVERS_DIR,
  BOOKS_DIR,
  DEFAULT_DB_PATH,
};

async function cli() {
  if (process.argv.includes('--reset')) {
    resetEverything();
    console.log('Removed booknest.db and public/uploads/.');
  }
  const { db, seeded, restored } = await initDatabase();
  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM Users) AS users, (SELECT COUNT(*) FROM Categories) AS categories,
              (SELECT COUNT(*) FROM Books) AS books, (SELECT COUNT(*) FROM Downloads) AS downloads,
              (SELECT COUNT(*) FROM Bookmarks) AS bookmarks, (SELECT COUNT(*) FROM Reviews) AS reviews,
              (SELECT COUNT(*) FROM Reading_Progress) AS reading_progress, (SELECT COUNT(*) FROM Reading_Notes) AS reading_notes,
              (SELECT COUNT(*) FROM Book_Requests) AS book_requests, (SELECT COUNT(*) FROM Request_Votes) AS request_votes,
              (SELECT COUNT(*) FROM Audit_Logs) AS audit_logs`
    )
    .get();
  console.log(seeded ? 'Database seeded.' : 'Database already contains data; seeding skipped.');
  if (restored) console.log(`Regenerated assets for ${restored} seed book(s).`);
  console.log(counts);
  db.close();
}

if (require.main === module) {
  cli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}