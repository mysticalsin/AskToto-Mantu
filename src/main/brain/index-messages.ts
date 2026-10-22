import type { IndexUnavailableCause } from '@shared/brain'

/** User-facing, content-free explanation for brainStatus.error. */
export function indexUnavailableMessage(cause: IndexUnavailableCause): string {
  switch (cause) {
    case 'undecryptable':
      return (
        "Mantu Intelligence can't read its index on this device: it was encrypted with a key this " +
        "device doesn't have (another device, or a keychain that is unavailable). Nothing was changed " +
        'or deleted. Indexing is paused on this device.'
      )
    case 'io':
      return (
        "Mantu Intelligence couldn't read its index file just now (it may still be downloading from " +
        'OneDrive). Nothing was changed. Indexing resumes automatically once the file can be read.'
      )
    case 'unsupported':
      return (
        "Mantu Intelligence's index was written by a newer version of Métis. Nothing was changed. " +
        'Update Métis on this device to resume indexing.'
      )
    case 'corrupt-kept':
      return (
        "Mantu Intelligence's index is damaged and the automatic repair limit for this folder has " +
        'been reached. Nothing was deleted. Indexing is paused on this device.'
      )
  }
}
