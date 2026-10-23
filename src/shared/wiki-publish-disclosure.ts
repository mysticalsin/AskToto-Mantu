export const WIKI_PUBLISH_DISCLOSURE_MODES = ['encrypted', 'plaintext'] as const
export type WikiPublishDisclosureMode = (typeof WIKI_PUBLISH_DISCLOSURE_MODES)[number]

export interface WikiPublishDisclosure {
  mode: WikiPublishDisclosureMode
  copy: string
}

/**
 * ASSUMED default: encrypted transcript mode until the owner chooses otherwise. Publishing remains a plaintext
 * markdown mirror in either mode, so the disclosure always says that before the publish toggle can be enabled.
 */
export function wikiPublishDisclosure(encryptTranscripts = true): WikiPublishDisclosure {
  if (encryptTranscripts) {
    return {
      mode: 'encrypted',
      copy: 'You are in encrypted mode. Publishing creates a plaintext wiki copy under your meetings folder for Dust and other agents to read, even though saved transcripts stay encrypted. Meetings marked confidential are excluded.'
    }
  }
  return {
    mode: 'plaintext',
    copy: 'You are in plaintext mode. Publishing creates a readable wiki copy under your meetings folder for Dust and other agents to read. Meetings marked confidential are excluded.'
  }
}
