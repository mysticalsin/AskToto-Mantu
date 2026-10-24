import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../test-helpers/module-source'
import { classifyTurn, TRIGGER_MAX_CHARS } from './turn-triggers'

const kind = (t: string) => classifyTurn(t)?.kind ?? null

describe('classifyTurn', () => {
  it('returns null for empty and whitespace', () => {
    expect(classifyTurn('')).toBeNull()
    expect(classifyTurn('   \n ')).toBeNull()
  })

  it('terminal ? ？ ؟ fire question with cue terminal-mark', () => {
    for (const t of ['Ready?', 'ready？', 'جاهز؟']) {
      expect(classifyTurn(t)).toMatchObject({ kind: 'question', cue: 'terminal-mark' })
    }
  })

  it('labels lang for punctuated FR/PT/ES via detectLanguage, null when unknown', () => {
    expect(classifyTurn('Est-ce que vous avez le temps de parler avec nous aujourd’hui?')?.lang).toBe('fr')
    expect(classifyTurn('Você está vendo isso e não acha muito caro para a gente, então vamos?')?.lang).toBe('pt-BR')
    expect(classifyTurn('¿Puedes explicarme cómo funciona esto para el equipo?')?.lang).toBe('es')
    expect(classifyTurn('Ready?')?.lang).toBeNull()
  })

  it('FR unpunctuated openers fire (pourquoi, est-ce que, combien, qu’est-ce que)', () => {
    for (const t of [
      'Pourquoi le projet Acme a pris du retard',
      'Est-ce que vous pouvez partager le plan',
      'Combien coûte la licence annuelle',
      'Qu’est-ce que vous proposez pour Globex'
    ]) {
      expect(classifyTurn(t), t).toMatchObject({ kind: 'question', lang: 'fr' })
    }
  })

  it('PT-BR unpunctuated openers fire (o que, por que, quanto, como, será que)', () => {
    for (const t of [
      'O que vocês propõem para a Acme',
      'Por que o prazo mudou tanto',
      'Quanto custa a licença anual',
      'Como funciona a integração com o CRM',
      'Será que dá para fechar hoje'
    ]) {
      expect(classifyTurn(t), t).toMatchObject({ kind: 'question', lang: 'pt-BR' })
    }
  })

  it('ES unpunctuated openers fire, accented and unaccented (cuánto/cuanto, por qué/por que)', () => {
    expect(classifyTurn('Cuánto cuesta la licencia anual')).toMatchObject({ kind: 'question', lang: 'es' })
    expect(classifyTurn('Cuanto cuesta la licencia anual')).toMatchObject({ kind: 'question', lang: 'es' })
    expect(kind('Por qué cambió el plazo del proyecto')).toBe('question')
    expect(kind('Por que cambio el plazo del proyecto')).toBe('question')
    expect(kind('Puedes explicar la integración con Globex')).toBe('question')
  })

  it('leading discourse marker is skipped (Então, quando…; Et alors pourquoi…; Y cuándo…)', () => {
    expect(kind('Então, quando vocês conseguem entregar')).toBe('question')
    expect(kind('Et alors pourquoi le prix a changé')).toBe('question')
    expect(kind('Y cuándo podemos empezar el piloto')).toBe('question')
    expect(kind('Ok mas how much does it cost')).toBe('question')
  })

  it('inverted ¿ opener fires without terminal mark', () => {
    expect(classifyTurn('¿Cuándo empezamos')).toMatchObject({ kind: 'question', cue: 'inverted-mark' })
  })

  it('tag questions fire (né, n’est-ce pas, verdad)', () => {
    expect(classifyTurn('Vamos fechar hoje, né')).toMatchObject({ kind: 'question', cue: 'tag-question' })
    expect(classifyTurn('Le prix reste le même, n’est-ce pas')).toMatchObject({ kind: 'question', cue: 'tag-question' })
    expect(classifyTurn('Empezamos el lunes, verdad')).toMatchObject({ kind: 'question', cue: 'tag-question' })
  })

  it('dangling FR/PT/ES endings do not fire (Combien coûte le; Qual é o; Cuánto cuesta el)', () => {
    expect(classifyTurn('Combien coûte le')).toBeNull()
    expect(classifyTurn('Qual é o')).toBeNull()
    expect(classifyTurn('Cuánto cuesta el')).toBeNull()
    expect(classifyTurn('Quanto custa o plano e')).toBeNull()
    expect(kind('De onde você é')).toBe('question') // ends on é, not a dangling e
    expect(kind('Tu es d’où')).toBeNull() // under the 3-word floor, no mark
  })

  it('porque, bare que and notOpeners do not fire (Que bom que…; Como eu disse…)', () => {
    expect(classifyTurn('Porque o prazo mudou bastante')).toBeNull()
    expect(classifyTurn('Que bom que vocês vieram hoje')).toBeNull()
    expect(classifyTurn('Como eu disse antes o prazo mudou')).toBeNull()
    expect(classifyTurn('Como dije antes el plazo cambió')).toBeNull()
    expect(classifyTurn('Comme je disais le prix a changé')).toBeNull()
  })

  it('objections fire per language with the right cue (one per cue × lang)', () => {
    const cases: Array<[string, string, string]> = [
      ['en', 'This is too expensive for us', 'obj-price'],
      ['en', 'That is not in our budget', 'obj-budget'],
      ['en', 'We already use Globex', 'obj-incumbent'],
      ['en', 'We don’t need another tool', 'obj-need'],
      ['en', 'I’m not sure about this', 'obj-doubt'],
      ['en', 'It is not a priority', 'obj-priority'],
      ['en', 'The problem is the rollout', 'obj-problem'],
      ['fr', 'C’est trop cher pour nous', 'obj-price'],
      ['fr', 'On est hors budget', 'obj-budget'],
      ['fr', 'On utilise déjà Globex', 'obj-incumbent'],
      ['fr', 'On n’a pas besoin d’un outil de plus', 'obj-need'],
      ['fr', 'Je ne suis pas convaincu', 'obj-doubt'],
      ['fr', 'Ce n’est pas une priorité', 'obj-priority'],
      ['fr', 'Le problème c’est le déploiement', 'obj-problem'],
      ['pt-BR', 'Isso é muito caro para nós', 'obj-price'],
      ['pt-BR', 'Está fora do nosso orçamento', 'obj-budget'],
      ['pt-BR', 'Já temos a Globex', 'obj-incumbent'],
      ['pt-BR', 'Não precisamos de outra ferramenta', 'obj-need'],
      ['pt-BR', 'Não tenho certeza', 'obj-doubt'],
      ['pt-BR', 'Isso não é prioridade', 'obj-priority'],
      ['pt-BR', 'O problema é a implantação', 'obj-problem'],
      ['es', 'Es demasiado caro para nosotros', 'obj-price'],
      ['es', 'Está fuera de nuestro presupuesto', 'obj-budget'],
      ['es', 'Ya tenemos a Globex', 'obj-incumbent'],
      ['es', 'No necesitamos otra herramienta', 'obj-need'],
      ['es', 'No estoy convencido', 'obj-doubt'],
      ['es', 'No es una prioridad', 'obj-priority'],
      ['es', 'El problema es el despliegue', 'obj-problem']
    ]
    for (const [lang, text, cue] of cases) {
      expect(classifyTurn(text), text).toEqual({ kind: 'objection', lang, cue })
    }
  })

  it('question beats objection', () => {
    expect(classifyTurn('Isn’t that too expensive?')?.kind).toBe('question')
    expect(classifyTurn('Why is it too expensive for Acme')?.kind).toBe('question')
  })

  it('evaluates only the last clause (earlier objection then a statement → null)', () => {
    expect(classifyTurn('It is too expensive. We will think about it.')).toBeNull()
    expect(kind('It is too expensive. What can you do about it')).toBe('question')
  })

  it('code-switch: EN opener after PT clause, PT opener with English nouns', () => {
    expect(kind('Entendi o ponto. What is the pricing')).toBe('question')
    expect(classifyTurn('Qual é o pricing do plano enterprise')).toMatchObject({ kind: 'question', lang: 'pt-BR' })
    expect(classifyTurn('Acme looks good mas é muito caro')).toMatchObject({ kind: 'objection', lang: 'pt-BR' })
  })

  it('input beyond 600 chars is truncated to the tail', () => {
    expect(TRIGGER_MAX_CHARS).toBe(600)
    const filler = 'palavra '.repeat(200)
    expect(classifyTurn('Pourquoi ' + filler)).toBeNull()
    expect(kind(filler + '. Pourquoi le projet Acme a pris du retard')).toBe('question')
  })

  it('result has only kind/lang/cue and echoes no input text', () => {
    const text = 'Pourquoi le projet Acme a pris du retard'
    const r = classifyTurn(text)
    expect(Object.keys(r ?? {}).sort()).toEqual(['cue', 'kind', 'lang'])
    for (const v of Object.values(r ?? {})) {
      for (const w of text.toLowerCase().split(/\s+/)) expect(String(v).toLowerCase()).not.toBe(w)
    }
  })
})

describe('turn-triggers source', () => {
  it('contains no console/log/audit calls', () => {
    for (const spec of ['./turn-triggers', './turn-trigger-lexicon']) {
      const { text } = readModuleSource(__dirname, spec)
      expect(text).not.toMatch(/console\.|logger|audit|telemetry|fetch\(/i)
    }
  })
})
