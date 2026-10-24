// Per-language cue tables for turn-triggers.ts (G72). Data only.
// Entries are regex fragments over ACCENT-STRIPPED, lowercase text with straight apostrophes: spaces match any
// whitespace run, `( | )` groups and `?` are allowed. The classifier normalises input the same way.

export const TRIGGER_LANGS = ['en', 'fr', 'pt-BR', 'es'] as const
export type TriggerLang = (typeof TRIGGER_LANGS)[number]

export const OBJECTION_CUES = [
  'obj-price',
  'obj-budget',
  'obj-incumbent',
  'obj-need',
  'obj-doubt',
  'obj-priority',
  'obj-problem'
] as const
export type ObjectionCue = (typeof OBJECTION_CUES)[number]

export interface LangLexicon {
  readonly openers: readonly string[]
  /** Clause openers that look like a question word but are statements ("como eu disse"). */
  readonly notOpeners: readonly string[]
  /** Tag questions; only counted after a comma. */
  readonly tags: readonly string[]
  /** Function words a finished question never ends on. Lowercase, accents kept (PT "é" is not "e"). */
  readonly dangling: readonly string[]
  readonly objections: Readonly<Record<ObjectionCue, readonly string[]>>
}

/** Discourse markers skipped before the opener test. */
export const LEAD_MARKERS: readonly string[] = [
  'and',
  'so',
  'but',
  'well',
  'ok',
  'okay',
  'et',
  'mais',
  'alors',
  'donc',
  'e',
  'mas',
  'entao',
  'tipo',
  'bom',
  'y',
  'pero',
  'entonces',
  'bueno',
  'vale'
]

export const LEXICON: Readonly<Record<TriggerLang, LangLexicon>> = Object.freeze({
  en: {
    openers: [
      'what',
      'why',
      'how',
      'when',
      'where',
      'who',
      'which',
      'can',
      'could',
      'would',
      'do',
      'does',
      'did',
      'are',
      'is',
      'have',
      'has',
      'tell me',
      'walk me',
      'describe',
      'explain',
      'give me'
    ],
    notOpeners: [],
    tags: [],
    dangling: ['the', 'a', 'an', 'and', 'or', 'but', 'your', 'my', 'our', 'their', 'its'],
    objections: {
      'obj-price': ['too expensive', 'costs too much', 'too pricey'],
      'obj-budget': ['not in (our|the) budget', 'over budget', 'no budget'],
      'obj-incumbent': ['we already (use|have)', "we're happy with"],
      'obj-need': ["we don't need", 'no need for'],
      'obj-doubt': ["i'm not sure (that|this|it|about)"],
      'obj-priority': ['not a priority'],
      'obj-problem': ['the problem is', 'my concern is', "doesn't work for us"]
    }
  },
  fr: {
    openers: [
      "qu'est-ce que",
      'est-ce que',
      "est-ce qu'",
      'pourquoi',
      'comment',
      'quand',
      'ou est',
      'ou sont',
      "d'ou",
      'qui',
      'quel',
      'quelle',
      'quels',
      'quelles',
      'combien',
      'pouvez-vous',
      'pourriez-vous',
      'peux-tu',
      'avez-vous',
      'est-il',
      'est-ce'
    ],
    notOpeners: ['comme je disais', 'comme on a dit'],
    tags: ["n'est-ce pas"],
    dangling: ['le', 'la', 'les', 'un', 'une', 'et', 'ou', 'mais', 'votre', 'notre', 'leur', 'du', 'des'],
    objections: {
      'obj-price': ['trop cher', 'ca coute trop'],
      'obj-budget': ['pas de budget', 'hors budget', 'pas dans (notre|le) budget'],
      'obj-incumbent': ['on a deja', 'nous avons deja', 'on utilise deja'],
      'obj-need': ["on n'a pas besoin", "nous n'avons pas besoin"],
      'obj-doubt': ['je ne suis pas (sur|sure|convaincu|convaincue)'],
      'obj-priority': ['pas une priorite', 'pas prioritaire'],
      'obj-problem': ["le probleme c'est", 'ca ne nous convient pas']
    }
  },
  'pt-BR': {
    openers: [
      'o que',
      'por que',
      'qual',
      'quais',
      'quando',
      'onde',
      'aonde',
      'de onde',
      'quem',
      'como',
      'quanto',
      'quanta',
      'quantos',
      'quantas',
      'voce pode',
      'voces podem',
      'poderia',
      'pode me',
      'tem como',
      'sera que'
    ],
    notOpeners: ['como eu disse', 'como falei', 'como voce sabe'],
    tags: ['ne', 'nao e', 'nao acha'],
    dangling: [
      'o',
      'os',
      'as',
      'um',
      'uma',
      'e',
      'ou',
      'mas',
      'seu',
      'sua',
      'nosso',
      'nossa',
      'do',
      'da',
      'dos',
      'das'
    ],
    objections: {
      'obj-price': ['muito caro', 'caro demais', 'custa muito'],
      'obj-budget': ['fora do (nosso )?orcamento', 'sem orcamento', 'nao temos orcamento'],
      'obj-incumbent': ['ja temos', 'ja usamos', 'estamos satisfeitos com'],
      'obj-need': ['nao precisamos', 'a gente nao precisa'],
      'obj-doubt': ['nao tenho certeza', 'nao estou convencid(o|a)'],
      'obj-priority': ['nao e (uma )?prioridade'],
      'obj-problem': ['o problema e', 'nao funciona (pra|para) (nos|a gente)']
    }
  },
  es: {
    openers: [
      'que es',
      'que son',
      'que hay',
      'que tal',
      'que opinas',
      'que piensas',
      'por que',
      'cual',
      'cuales',
      'cuando',
      'donde',
      'adonde',
      'de donde',
      'quien',
      'quienes',
      'como',
      'cuanto',
      'cuanta',
      'cuantos',
      'cuantas',
      'puede',
      'puedes',
      'podria',
      'podrias',
      'me puedes'
    ],
    notOpeners: ['como dije', 'como sabes'],
    tags: ['verdad', 'no crees'],
    dangling: ['el', 'los', 'las', 'un', 'una', 'y', 'o', 'pero', 'su', 'nuestro', 'nuestra', 'del'],
    objections: {
      'obj-price': ['muy caro', 'demasiado caro', 'cuesta mucho'],
      'obj-budget': ['fuera del? (nuestro )?presupuesto', 'sin presupuesto', 'no tenemos presupuesto'],
      'obj-incumbent': ['ya tenemos', 'ya usamos', 'estamos contentos con'],
      'obj-need': ['no necesitamos', 'no nos hace falta'],
      'obj-doubt': ['no estoy (seguro|segura|convencido|convencida)'],
      'obj-priority': ['no es (una )?prioridad'],
      'obj-problem': ['el problema es', 'no nos funciona']
    }
  }
})
