// ==========================================================================
// Traffic Scout — Gemini Multimodal Visual Traffic Analyst & Native TTS
// ==========================================================================

import { CONFIG } from "./config.js";

function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

/**
 * Converts 24kHz 16-bit mono PCM audio buffer into a playable WAV ArrayBuffer.
 */
export function pcmToWav(pcmData, sampleRate = 24000) {
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = pcmData.byteLength;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeString(view, 8, "WAVE");
    writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeString(view, 36, "data");
    view.setUint32(40, dataSize, true);

    const pcmBytes = new Uint8Array(pcmData);
    const wavBytes = new Uint8Array(buffer, 44);
    wavBytes.set(pcmBytes);

    return buffer;
}

export const GeminiService = {
    /**
     * Generates a consolidated traffic report from camera snapshots (or text fallback).
     */
    async generateMultimodal(apiKey, prompt, imagesBase64 = []) {
        if (!apiKey) {
            return "ERROR: Please set your Gemini API Key in Settings first.";
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_VISION_MODEL}:generateContent?key=${apiKey}`;

        const parts = [{ text: prompt }];

        imagesBase64.forEach(img => {
            if (img) {
                parts.push({
                    inlineData: {
                        mimeType: "image/jpeg",
                        data: img
                    }
                });
            }
        });

        const payload = {
            contents: [{ role: "user", parts }]
        };

        try {
            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                throw new Error(`API Error: ${response.status}`);
            }

            const data = await response.json();
            return data.candidates?.[0]?.content?.parts?.[0]?.text || "No response from AI.";
        } catch (error) {
            console.error("Gemini Error:", error);
            return `System Error: Unable to reach analysis service (${error.message}).`;
        }
    },

    /**
     * Converts report text into spoken audio using Gemini Native Audio TTS ("Kore" voice).
     */
    async speak(apiKey, text) {
        if (!apiKey) throw new Error("Missing Gemini API Key");

        const cleanText = text.replace(/\*\*/g, "").replace(/[#*-]/g, " ");
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_TTS_MODEL}:generateContent?key=${apiKey}`;

        const payload = {
            contents: [{ parts: [{ text: cleanText }] }],
            generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: { voiceName: CONFIG.GEMINI_TTS_VOICE }
                    }
                }
            }
        };

        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error(`TTS API Error: ${response.status}`);
        }

        const data = await response.json();
        const audioBase64 = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (!audioBase64) {
            throw new Error("No audio payload returned from TTS model");
        }

        const binaryString = window.atob(audioBase64);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        const wavBuffer = pcmToWav(bytes.buffer, 24000);
        const blob = new Blob([wavBuffer], { type: "audio/wav" });
        const audioUrl = URL.createObjectURL(blob);

        return new Audio(audioUrl);
    }
};
