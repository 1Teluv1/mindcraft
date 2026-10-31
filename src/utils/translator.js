// Compatibility entry points: player input and model output are never translated.
// Generate the desired language directly through the NPC profile prompts.
export async function handleTranslation(message) {
    return message;
}

export async function handleEnglishTranslation(message) {
    return message;
}
