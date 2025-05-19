/*
Copyright © 2024 lorenzetti giuseppe. All rights reserved.
*/

const { Renderer, Stave, StaveNote, Beam, Formatter, StaveConnector, Voice, Accidental, Dot, TickContext, Barline } = Vex.Flow;
const VF = Vex.Flow;

let renderer = null;
let context = null;

const container = document.getElementById('pentagramma-container');
const fileInput = document.getElementById('midi-file-input');
const statusDisplay = document.getElementById('playback-status');
const playButton = document.getElementById('play-button');
const stopButton = document.getElementById('stop-button');
const exportPngButton = document.getElementById('export-png-button');
const speedSlider = document.getElementById('speed-slider');
const speedValueSpan = document.getElementById('speed-value');
const accuracyDisplay = document.getElementById('accuracy-display');

const STAVE_WIDTH = 280;
const MEASURES_PER_LINE = 4;
const STAVE_VERTICAL_SPACING = 120;
const SYSTEM_VERTICAL_SPACING = 250;
const STAVE_START_X = 15;
const NOTE_SPLIT_POINT = 60;
const TICK_TOLERANCE_FOR_CHORDS = 5;
const MIN_REST_TICKS = 1;

let ppq = 480;
let vexflowData = null;
let playbackInterval = null;
let currentNoteIndex = -1;
let allParsedNotesFlattened = [];
let svgElementsMap = new Map();
let userNoteInputListener = null;
let lastUserMidiInput = null;
let totalNotesInExercise = 0;
let correctNotesCount = 0;

function ticksToVexflowDuration(ticks) {
    const q = ppq;
    if (q <= 0 || ticks < MIN_REST_TICKS) {
         return { duration: "0", dots: 0 };
    }

    const durationMap = [
        { ticks: q * 4, duration: "w", dots: 0 },
        { ticks: q * 3, duration: "h", dots: 1 },
        { ticks: q * 2, duration: "h", dots: 0 },
        { ticks: q * 1.5, duration: "q", dots: 1 },
        { ticks: q * 1, duration: "q", dots: 0 },
        { ticks: q * 0.75, duration: "8", dots: 1 },
        { ticks: q * 0.5, duration: "8", dots: 0 },
        { ticks: q * 0.375, duration: "16", dots: 1 },
        { ticks: q * 0.25, duration: "16", dots: 0 },
        { ticks: q * 0.125, duration: "32", dots: 0 },
        { ticks: q * 0.0625, duration: "64", dots: 0 }
    ];

    const tolerance = ppq * 0.02;

    for (const map of durationMap) {
        if (Math.abs(ticks - map.ticks) < tolerance) {
            return { duration: map.duration, dots: map.dots };
        }
    }

    let bestMatch = { duration: "32", dots: 0 };
    let minDiff = Infinity;

    for (const map of durationMap) {
        const diff = Math.abs(ticks - map.ticks);
        if (diff < minDiff) {
            minDiff = diff;
            bestMatch = { duration: map.duration, dots: map.dots };
        }
    }

     if (ticks > 0 && bestMatch.ticks > ticks * 2 && ticks < ppq * 0.1) {
         console.warn(`[ticksToVexflowDuration] Durata molto corta (${ticks} ticks) mappata a ${bestMatch.duration} (${bestMatch.ticks} ticks) con diff ${minDiff}. Misura PPQ: ${q}.`);
     } else if (ticks > 0 && minDiff > tolerance * 2) {
          console.warn(`[ticksToVexflowDuration] Nessun match entro tolleranza ${tolerance} per ${ticks} ticks. Miglior match: ${bestMatch.duration} (${bestMatch.ticks} ticks) con diff ${minDiff}. Misura PPQ: ${q}.`);
     }

    return bestMatch;
}

function midiNumberToVexflowNote(midiNumber) {
    const n = ["c","c#","d","d#","e","f","f#","g","g#","a","a#","b"];
    const o = Math.floor(midiNumber / 12) - 1;
    const i = midiNumber % 12;
    return `${n[i]}/${o}`;
}

function groupNotesByMeasure(notes, timeSignature, ppqInput) {
    if (!timeSignature || timeSignature.length < 2 || !ppqInput || ppqInput <= 0) {
        console.warn("[groupNotesByMeasure] TimeSignature o PPQ non validi. Uso default 4/4 @ 480 PPQ.");
        timeSignature = [4, 4];
        ppqInput = 480;
    }
    let [beats, unit] = timeSignature;
    if (typeof unit !== 'number' || unit <= 0 || (Math.log2(unit) % 1 !== 0 && unit !== 1)) {
        console.warn(`[groupNotesByMeasure] Unità TimeSignature (${unit}) non valida. Uso default 4.`);
        unit = 4;
    }

    const ticksPerBeat = ppqInput * (4 / unit);
    const ticksPerMeasure = ticksPerBeat * beats;

    if (ticksPerMeasure <= 0) {
        console.warn("[groupNotesByMeasure] TicksPerMeasure non valido o zero. Gruppo tutte le note in una misura.", { timeSignature, ppqInput, ticksPerMeasure });
         if (notes.length > 0) {
             return [notes];
         } else {
             return [[]];
         }
    }

    const measures = [];
    let currentNotes = [];
    let currentMeasureStartTick = 0;

    notes.sort((a, b) => a.ticks - b.ticks || a.midi - b.midi);

    if (notes.length > 0 && notes[0].ticks > TICK_TOLERANCE_FOR_CHORDS) {
        // CORREZIONE QUI: TICK_TICK_TOLERANCE_FOR_CHORDS -> TICK_TOLERANCE_FOR_CHORDS
        let initialEmptyMeasures = Math.floor((notes[0].ticks - TICK_TOLERANCE_FOR_CHORDS) / ticksPerMeasure);
        if (initialEmptyMeasures < 0) initialEmptyMeasures = 0;

        for (let i = 0; i < initialEmptyMeasures; i++) {
            measures.push([]);
        }
         currentMeasureStartTick = initialEmptyMeasures * ticksPerMeasure;
         console.log(`[groupNotesByMeasure] Aggiunte ${initialEmptyMeasures} misure vuote iniziali.`);
    } else if (notes.length === 0) {
         measures.push([]);
         console.log("[groupNotesByMeasure] Nessuna note trovata. Aggiunta una misura vuota.");
         return measures;
    } else {
         console.log("[groupNotesByMeasure] La prima note inizia vicino a tick 0. Inizio con la prima misura popolata.");
    }

    notes.forEach(note => {
        const noteStartTickAdjusted = note.ticks - currentMeasureStartTick;
        // CORREZIONE QUI: TICK_TICK_TOLERANCE_FOR_CHORDS -> TICK_TOLERANCE_FOR_CHORDS
        const measuresToSkip = Math.floor((noteStartTickAdjusted + TICK_TOLERANCE_FOR_CHORDS) / ticksPerMeasure);

        for (let i = 0; i < measuresToSkip; i++) {
             measures.push(currentNotes);
             currentNotes = [];
             currentMeasureStartTick += ticksPerMeasure;
        }

        currentNotes.push(note);
    });

    if (currentNotes.length > 0) {
        measures.push(currentNotes);
    } else if (measures.length === 0 && notes.length > 0) {
         console.warn("[groupNotesByMeasure] Nessuna misura generata nonostante la presenza di note dopo il loop. Ritorno note in singola misura finale.");
         measures.push(notes);
    } else if (measures.length === 0 && notes.length === 0) {
         measures.push([]);
         console.log("[groupNotesByMeasure] Nessuna nota e nessuna misura creata. Aggiunta una misura vuota finale.");
    }

    const cleanedMeasures = measures.filter(measure => measure !== null && measure !== undefined);

     if (cleanedMeasures.length === 0 && notes.length >= 0) {
         console.warn("[groupNotesByMeasure] Tutte le misure filtrate o non create. Aggiunta una misura vuota.");
         return [[]];
     }

    return cleanedMeasures;
}

function groupNotesByTick(notesList, tolerance) {
    const grouped = [];
    if (!notesList || notesList.length === 0) return grouped;

    notesList.sort((a, b) => a.ticks - b.ticks || a.midi - b.midi);

    let i = 0;
    while (i < notesList.length) {
        const currentNote = notesList[i];
        const chordGroup = [currentNote];
        let j = i + 1;
        while (j < notesList.length && Math.abs(notesList[j].ticks - currentNote.ticks) <= tolerance) {
            chordGroup.push(notesList[j]);
            j++;
        }
        chordGroup.sort((a, b) => a.midi - b.midi);
        grouped.push(chordGroup);
        i = j;
    }
    return grouped;
}


function processStaveNotesAndRests(chordGroupsForStave, staveType, ticksPerMeasure, startTickOfMeasure, measureIndex, ppqInput) {
    const rawTickables = [];
    const totalQLForMeasure = ticksPerMeasure / ppqInput;
    const minRestQL = MIN_REST_TICKS / ppqInput;

    if (chordGroupsForStave.length === 0) {
        try {
            const restTickable = new Vex.Flow.StaveNote({ keys: [staveType === "treble" ? "b/4" : "d/3"], duration: "Wr", clef: staveType });
            rawTickables.push(restTickable);
            console.log(`DEBUG REST: Added full measure rest to empty ${staveType} stave in measure ${measureIndex + 1}.`);
        } catch (e) {
            console.error(`Errore creazione Vex.Flow.StaveNote (Full Measure Rest) misura ${measureIndex + 1} ${staveType}:`, e);
        }

    } else {

        let currentQLInMeasure = 0;

        chordGroupsForStave.sort((a, b) => a[0].ticks - b[0].ticks);


        chordGroupsForStave.forEach(chordGroup => {
             if (chordGroup.length === 0) return;

             const noteBase = chordGroup[0];

            currentQLInMeasure = Math.max(currentQLInMeasure, (noteBase.ticks - startTickOfMeasure) / ppqInput - (TICK_TOLERANCE_FOR_CHORDS / ppqInput));


            let shortestDurationQLInChord = Infinity;
             if (chordGroup.length > 0) {
                 shortestDurationQLInChord = chordGroup[0].durationTicks / ppqInput;
                 chordGroup.forEach(note => {
                      const noteDurationQL = note.durationTicks / ppqInput;
                      if (noteDurationQL > 0 && noteDurationQL < shortestDurationQLInChord) {
                          shortestDurationQLInChord = noteDurationQL;
                      } else if (noteDurationQL <= 0) {
                           console.warn(`[processaStaveNotesAndRests] Durata zero/negativa (${note.durationTicks} ticks) per nota ID ${note.id} in accordo. Ignorata per durata accordo.`);
                      }
                 });
             }

             if (shortestDurationQLInChord <= 0 || shortestDurationQLInChord === Infinity) {
                 console.warn(`[processaStaveNotesAndRests] Durata effettiva zero/negativa per accordo a tick ${noteBase.ticks}. Imposto durata minima.`);
                 shortestDurationQLInChord = MIN_REST_TICKS / ppqInput;
             }


            const tempChordTicks = shortestDurationQLInChord * ppqInput;
            const { duration, dots } = ticksToVexflowDuration(tempChordTicks);

            if (!duration || duration === "0") {
                console.warn(`[processaStaveNotesAndRests] Durata convertita non valida "${duration}" per accordo a QL ${currentQLInMeasure.toFixed(2)}. Saltato disegno per gruppo:`, chordGroup.map(n => n.id));
                 currentQLInMeasure += shortestDurationQLInChord;
                 return;
            }

            const chordKeys = chordGroup.map(noteData => {
                const fullName = noteData.noteNameWithOctave;
                if (!fullName) {
                    console.warn(`Note ID ${noteData.id} missing noteNameWithOctave. Falling back to midiNumberToVexflowNote.`);
                    return midiNumberToVexflowNote(noteData.midi);
                }

                const match = fullName.match(/^([A-G](?:#|-|n)?)(\d+)$/i);
                if (!match || match.length !== 3) {
                     console.warn(`Could not parse noteNameWithOctave "${fullName}" into base note and octave for note ID ${noteData.id}. Falling back to midiNumberToVexflowNote.`);
                     return midiNumberToVexflowNote(noteData.midi);
                }

                const baseNoteLetter = match[1].charAt(0).toLowerCase();
                const octave = match[2];

                const vexflowKey = `${baseNoteLetter}/${octave}`;

                return vexflowKey;
            });

            const mainNoteForChord = chordGroup[0];

            try {
                const staveNoteOptions = { keys: chordKeys, duration: duration, clef: staveType };
                staveNoteOptions.auto_stem = true;

                const staveTickable = new Vex.Flow.StaveNote(staveNoteOptions);
                staveTickable.originalNotes = chordGroup;


                if (dots > 0) {
                     for (let d = 0; d < dots; d++) {
                        staveTickable.addModifier(new Vex.Flow.Dot(), 0);
                     }
                }

                chordGroup.forEach((noteData, index) => {
                    if (noteData.accidental) {
                        try {
                             staveTickable.addModifier(new Accidental(noteData.accidental), index);
                        } catch (accError) {
                             console.warn(`Errore aggiunta alterazione '${noteData.accidental}' a nota ID ${noteData.id} (misura ${measureIndex + 1}, ${staveType}, key index ${index}):`, accError);
                        }
                    }
                });

                rawTickables.push(staveTickable);

                currentQLInMeasure += shortestDurationQLInChord;


            } catch (e) {
                console.error(`Errore creazione Vex.Flow.StaveNote (primo ID dati nel gruppo: ${mainNoteForChord ? mainNoteForChord.id : 'N/A'}) misura ${measureIndex + 1} ${staveType}:`, { keys: chordKeys, duration: duration, dots: dots, group: chordGroup }, e);
                 currentQLInMeasure += shortestDurationQLInChord;
            }
        });
    }

    const finalTickables = [];
    let currentBeamCandidates = [];

    const isBeamableDuration = (tickable) => {
        if (!(tickable instanceof Vex.Flow.StaveNote) || tickable.isRest()) return false;
        const duration = tickable.getDuration();
        return ['8', '16', '32', '64'].some(d => duration.startsWith(d));
    };

    const getLowestNoteMidi = (tickable) => {
        const originalNotes = tickable.originalNotes;
        return originalNotes && originalNotes.length > 0 ? originalNotes[0].midi : -1;
    };


    for (let k = 0; k < rawTickables.length; k++) {
        const tickable = rawTickables[k];

        if (isBeamableDuration(tickable)) {
            if (currentBeamCandidates.length === 0) {
                currentBeamCandidates.push(tickable);
            } else {
                const lastCandidate = currentBeamCandidates[currentBeamCandidates.length - 1];
                const currentMidi = getLowestNoteMidi(tickable);
                const lastMidi = getLowestNoteMidi(lastCandidate);

                if (currentMidi !== -1 && lastMidi !== -1 && currentMidi < lastMidi) {
                    currentBeamCandidates.push(tickable);
                } else {
                    if (currentBeamCandidates.length > 1) {
                         finalTickables.push(new Vex.Flow.Beam(currentBeamCandidates));
                    } else if (currentBeamCandidates.length === 1) {
                        finalTickables.push(currentBeamCandidates[0]);
                    }
                    currentBeamCandidates = [tickable];
                }
            }
        } else {
             if (currentBeamCandidates.length > 1) {
                 finalTickables.push(new Vex.Flow.Beam(currentBeamCandidates));
             } else if (currentBeamCandidates.length === 1) {
                  finalTickables.push(currentBeamCandidates[0]);
             }
            currentBeamCandidates = [];

            finalTickables.push(tickable);
        }
    }

    if (currentBeamCandidates.length > 1) {
        finalTickables.push(new Vex.Flow.Beam(currentBeamCandidates));
    } else if (currentBeamCandidates.length === 1) {
        finalTickables.push(currentBeamCandidates[0]);
    }

    return finalTickables;
}

function convertMusic21KeyToVexflow(music21KeyName) {
    if (!music21KeyName) return "C";

    let vexflowKey = music21KeyName;

    vexflowKey = vexflowKey.replace('-', 'b');

    return vexflowKey;
}


function generateVexflowJson(metadataFromBackend, allParsedNotesFromBackend) {
    console.log("[CONVERT] Inizio generazione VexFlow JSON...");

    ppq = metadataFromBackend?.ppq || 480;
    console.log(`[CONVERT] PPQ globale: ${ppq}`);

    const notesToProcess = allParsedNotesFromBackend || [];
    console.log(`[CONVERT] Note da processare: ${notesToProcess.length}`);

    let timeSigStr = metadataFromBackend?.timeSignature || "4/4";
    let [beats, unit] = timeSigStr.split('/').map(Number);
    if (isNaN(beats) || isNaN(unit) || unit <= 0 || (Math.log2(unit) % 1 !== 0 && unit !== 1)) {
         console.warn(`[CONVERT] TimeSig "${timeSigStr}" non valida. Uso default 4/4.`);
         timeSigStr = "4/4"; beats = 4; unit = 4;
         if (metadataFromBackend) { metadataFromBackend.timeSignature = timeSigStr; }
    }
    console.log(`[CONVERT] Usando TimeSig: ${timeSigStr}`);

    const music21KeySig = metadataFromBackend?.keySignature || "C";
    const keySigForVexFlow = convertMusic21KeyToVexflow(music21KeySig);
    console.log(`[CONVERT] Usando KeySig per VexFlow: ${keySigForVexFlow} (convertito da music21: ${music21KeySig}).`);

    const ticksPerBeat = ppq * (4 / unit);
    const ticksPerMeasure = ticksPerBeat * beats;
    console.log(`[CONVERT] Ticks per misura: ${ticksPerMeasure}`);
     if (ticksPerMeasure <= 0) {
         console.error("[CONVERT] Ticks per misura è zero o negativo. Impossibile generare VexFlow data.");
         return null;
     }

    const measuresGroupedAll = groupNotesByMeasure(notesToProcess, [beats, unit], ppq);
    console.log(`[CONVERT] Note raggruppate in ${measuresGroupedAll.length} misure.`);

    const vexflowMeasures = [];
    measuresGroupedAll.forEach((measureNotesOriginal, measureIndex) => {
        const startTickOfMeasure = measureIndex * ticksPerMeasure;

        // --- NUOVA LOGICA: Raggruppa per accordo e assegna l'intero accordo a un rigo ---
        const measureChordGroups = groupNotesByTick(measureNotesOriginal, TICK_TOLERANCE_FOR_CHORDS);

        const currentMeasureNotesTreble = [];
        const currentMeasureNotesBass = [];

        measureChordGroups.forEach(chordGroup => {
             if (chordGroup.length === 0) return;

             const lowestNote = chordGroup.reduce((minNote, currentNote) => {
                 return (minNote === null || currentNote.midi < minNote.midi) ? currentNote : minNote;
             }, null);

             const targetStave = (lowestNote && lowestNote.midi >= NOTE_SPLIT_POINT) ? 'treble' : 'bass';

             // Aggiungi l'intero gruppo (l'accordo) alla lista delle note per il rigo target
             // Non aggiungiamo le note individuali, ma il gruppo per mantenerle unite.
             // processStaveNotesAndRests si aspetta un array di gruppi di note.
             if (targetStave === 'treble') {
                 currentMeasureNotesTreble.push(chordGroup);
             } else {
                 currentMeasureNotesBass.push(chordGroup);
             }
        });
        // --- FINE NUOVA LOGICA ---


        // Processa i gruppi di accordi per creare tickables.
        // processStaveNotesAndRests ora si aspetta una lista di gruppi di note (accordi).
        const trebleTickablesVex = processStaveNotesAndRests(currentMeasureNotesTreble, "treble", ticksPerMeasure, startTickOfMeasure, measureIndex, ppq);
        const bassTickablesVex = processStaveNotesAndRests(currentMeasureNotesBass, "bass", ticksPerMeasure, startTickOfMeasure, measureIndex, ppq);


        vexflowMeasures.push({
            measureIndex: measureIndex,
            startTick: startTickOfMeasure,
            staves: {
                treble: trebleTickablesVex,
                bass: bassTickablesVex
            }
        });
    });

    if (vexflowMeasures.length > 0) {
         const lastMeasure = vexflowMeasures[vexflowMeasures.length - 1];
         const lastMeasureEndTick = lastMeasure.startTick + ticksPerMeasure;
         const lastNote = notesToProcess[notesToProcess.length - 1];
         if (lastNote && lastMeasure && lastNote.ticks >= lastMeasure.startTick) {
             vexflowMeasures.push({
                 measureIndex: vexflowMeasures.length,
                 startTick: lastMeasureEndTick,
                 staves: { treble: [], bass: [] }
             });
              console.log("[CONVERT] Aggiunta misura vuota finale per doppia barra.");
         } else if (notesToProcess.length === 0 && vexflowMeasures.length > 0) {
         } else if (notesToProcess.length > 0 && vexflowMeasures.length === 0) {
              console.warn("[CONVERT] Note presenti ma nessuna misura creata. Non aggiungo misura finale.");
         }


    } else if (notesToProcess.length > 0) {
         console.error("[CONVERT] Impossibile generare VexFlow measures. Ticks per misura non valido.");
         return null;
    }


    console.log(`[CONVERT] Struttura VexFlow JSON completata con ${vexflowMeasures.length} misure.`);
    return {
        metadata: {
            ...metadataFromBackend,
            timeSignature: timeSigStr,
             keySignature: keySigForVexFlow
        },
        measures: vexflowMeasures
    };
}

async function drawMusicSheetFromJson(vexflowData) {
    console.log("[DRAW] Inizio disegno partitura...");

    if (!vexflowData || !vexflowData.measures?.length) {
        console.error("[DRAW] Dati JSON non validi o misure mancanti per il disegno.");
        if(statusDisplay) statusDisplay.textContent = 'Impossibile disegnare la partitura. Dati non validi.';
        container.innerHTML = '<p>Impossibile disegnare la partitura. Dati non validi.</p>';
        disableButtons();
        accuracyDisplay.textContent = "Accuratezza: N/A";
        return;
    }

    stopPlayback();
     svgElementsMap = new Map();

    allParsedNotesFlattened = [];
    currentNoteIndex = -1;
    correctNotesCount = 0;
    totalNotesInExercise = 0;
    updateAccuracyDisplay();

    setupRenderer();

    const timeSig = vexflowData.metadata.timeSignature;
    // const keySig = vexflowData.metadata.keySignature; // Non usiamo più l'armatura di chiave qui
    const totalMeasures = vexflowData.measures.length;

    const totalLines = Math.ceil(totalMeasures / MEASURES_PER_LINE);
    const totalHeight = totalLines * SYSTEM_VERTICAL_SPACING + 60;
    const staveAreaWidth = STAVE_WIDTH * MEASURES_PER_LINE;
    const totalWidth = STAVE_START_X + staveAreaWidth + STAVE_START_X;

    renderer.resize(totalWidth, totalHeight);
    context.setFont('Arial', 10).setBackgroundFillStyle('#fff');

    let currentY = 40;
    const staveLayout = [];

    console.log("[DRAW] Disegno righi e barre...");
    for (let lineIndex = 0; lineIndex < totalLines; lineIndex++) {
        for (let measureInLine = 0; measureInLine < MEASURES_PER_LINE; measureInLine++) {
            const measureIndex = lineIndex * MEASURES_PER_LINE + measureInLine;
            if (measureIndex >= totalMeasures) break;

            const currentX = STAVE_START_X + (measureInLine * STAVE_WIDTH);

            const trebleStave = new Stave(currentX, currentY, STAVE_WIDTH);
            const bassStave = new Stave(currentX, currentY + STAVE_VERTICAL_SPACING, STAVE_WIDTH);

            if (measureIndex === 0) {
                trebleStave.addClef("treble").addTimeSignature(timeSig);
                bassStave.addClef("bass").addTimeSignature(timeSig);
                new Vex.Flow.StaveConnector(trebleStave, bassStave).setType(VF.StaveConnector.type.BRACE).setContext(context).draw();
            } else if (measureInLine === 0) {
                 trebleStave.addClef("treble");
                 bassStave.addClef("bass");
                 new Vex.Flow.StaveConnector(trebleStave, bassStave).setType(VF.StaveConnector.type.SINGLE_LEFT).setContext(context).draw();
            } else {
            }
             const barlineType = measureIndex === totalMeasures - 1 ? VF.Barline.type.END : VF.Barline.type.SINGLE;
             trebleStave.setEndBarType(barlineType);
             bassStave.setEndBarType(barlineType);

            trebleStave.setContext(context).draw();
            bassStave.setContext(context).draw();

            staveLayout[measureIndex] = { trebleStave, bassStave };
        }

        const lastMeasureIndexInLine = Math.min(lineIndex * MEASURES_PER_LINE + MEASURES_PER_LINE - 1, totalMeasures - 1);
        if (lastMeasureIndexInLine >= lineIndex * MEASURES_PER_LINE && lastMeasureIndexInLine < totalMeasures - 1) {
             const lastStavePair = staveLayout[lastMeasureIndexInLine];
             if (lastStavePair) {
                  new Vex.Flow.StaveConnector(lastStavePair.trebleStave, lastStavePair.bassStave).setType(VF.StaveConnector.type.SINGLE_RIGHT).setContext(context).draw();
             }
        }


        currentY += SYSTEM_VERTICAL_SPACING;
    }

    console.log("[DRAW] Formatto e disegno note e resti...");
    vexflowData.measures.forEach((measureData, measureIndex) => {
        const stavePair = staveLayout[measureIndex];
        if (!stavePair) {
            console.warn(`[DRAW] Staves non trovati per misura ${measureIndex + 1}`);
            return;
        }

        const { trebleStave, bassStave } = stavePair;
        const trebleTickablesVex = measureData.staves.treble || [];
        const bassTickablesVex = measureData.staves.bass || [];

        const formatterWidthTreble = trebleStave.getNoteEndX() - trebleStave.getNoteStartX();
        const formatterWidthBass = bassStave.getNoteEndX() - bassStave.getNoteStartX();


        try {
            if (trebleTickablesVex.length > 0) {
                const [beats_str, val_str] = timeSig.split('/');
                const beats = parseInt(beats_str); const val = parseInt(val_str);
                const voice = new Voice({ num_beats: beats, beat_value: val }).setStrict(false).addTickables(trebleTickablesVex);
                new Formatter().joinVoices([voice]).format([voice], formatterWidthTreble);
                voice.draw(context, trebleStave);
            }
        } catch (e) { console.error(`ERRORE Draw Voice Treble misura ${measureIndex + 1}:`, e); }

        try {
            if (bassTickablesVex.length > 0) {
                 const [beats_str, val_str] = timeSig.split('/');
                const beats = parseInt(beats_str); const val = parseInt(val_str);
                const voice = new Voice({ num_beats: beats, beat_value: val }).setStrict(false).addTickables(bassTickablesVex);
                new Formatter().joinVoices([voice]).format([voice], formatterWidthBass);
                voice.draw(context, bassStave);
            }
        } catch (e) { console.error(`ERRORE Draw Voice Bass misura ${measureIndex + 1}:`, e); }
    });

    console.log("[DRAW] Mapping elementi SVG e creazione elenco note piatto...");
     vexflowData.measures.forEach(measureData => {
         ['treble', 'bass'].forEach(staveType => {
             const tickables = measureData.staves[staveType];

             tickables.forEach(tickable => {
                const notesInThisTickable = (tickable instanceof Vex.Flow.Beam) ? tickable.getNotes() : [tickable];

                notesInThisTickable.forEach(noteOrChordTickable => {
                     if (noteOrChordTickable instanceof Vex.Flow.StaveNote && !noteOrChordTickable.isRest()) {
                         const originalNotesInGroup = noteOrChordTickable.originalNotes;

                          if (originalNotesInGroup) {
                              originalNotesInGroup.forEach(originalNoteData => {
                                  if (!allParsedNotesFlattened.find(n => n.id === originalNoteData.id)) {
                                       allParsedNotesFlattened.push({ ...originalNoteData, vexflowTickable: noteOrChordTickable });
                                  }
                              });
                          } else {
                             console.warn(`[DRAW] No originalNotes found for tickable. Cannot add to flattened list.`);
                         }
                     }
                });
             });
         });
     });

     allParsedNotesFlattened.sort((a, b) => a.ticks - b.ticks || a.midi - b.midi);

     console.log("[DRAW] Note appiattite per riproduzione/esercizio:", allParsedNotesFlattened.map(n => ({ id: n.id, ticks: n.ticks, midi: n.midi, name: n.noteNameWithOctave, durationTicks: n.durationTicks, accidental: n.accidental, hasTickable: !!n.vexflowTickable })));

     totalNotesInExercise = allParsedNotesFlattened.filter(note => note.midi >= 0).length;
     updateAccuracyDisplay();

     mapTickablesToSvgElements();

    console.log("[DRAW] Partitura disegnata.");
    if(statusDisplay) statusDisplay.textContent = "Partitura caricata. Pronto per l'esercizio.";
    enableButtons();
}

function setupRenderer() {
     removeHighlightClasses();

    container.innerHTML = '';
    renderer = new Renderer(container, Renderer.Backends.SVG);
    renderer.resize(800, 600);
    context = renderer.getContext();
    context.setFont('Arial', 10).setBackgroundFillStyle('#fff');
}

function removeHighlightClasses() {
    if (!container) return;
    const highlighted = container.querySelectorAll('.current-note-highlight, .correct-note, .incorrect-note-flash');
    highlighted.forEach(el => {
        el.classList.remove('current-note-highlight', 'correct-note', 'incorrect-note-flash');
        el.style.animation = '';
        el.style.fill = '';
        el.style.stroke = '';
    });
}

async function handleFileSelect(event) {
    console.log("[FILE] Selezione file rilevata.");
    disableButtons();
    stopPlayback();

    const file = event.target.files[0];
    if (!file) {
        console.log("[FILE] Nessun file selezionato.");
        if (statusDisplay) statusDisplay.textContent = "Carica un file MIDI.";
        setupRenderer();
        accuracyDisplay.textContent = "Accuratezza: N/A";
        return;
    }

    console.log(`[FILE] File selezionato: ${file.name}`);

    container.innerHTML = '<p>Caricamento e analisi...</p>';
    if(statusDisplay) statusDisplay.textContent = "Lettura file...";

    const reader = new FileReader();
    reader.onloadend = async () => {
        if (reader.error) {
             console.error("[FILE] Errore lettura file:", reader.error);
             alert("Impossibile leggere il file selezionato.");
             container.innerHTML = '<p>Errore lettura file.</p>';
             if(statusDisplay) statusDisplay.textContent = "Erro lettura file.";
             return;
        }

        const base64String = reader.result;
        console.log("[FILE] File letto. Invio al backend per elaborazione...");
        if(statusDisplay) statusDisplay.textContent = "Invio al backend...";

        try {
            const response = await fetch('http://127.0.0.1:5000/process_midi', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ midiData: base64String })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: response.statusText, detail: "Nessun JSON di errore nella risposta backend." }));
                const errorMessage = errorData.error || response.statusText;
                const errorDetail = errorData.detail || "";
                console.error(`[FILE] Errore risposta backend: HTTP ${response.status} - ${errorMessage}`, errorData);
                throw new Error(`Elaborazione backend fallita: ${errorMessage} (Status: ${response.status}). Dettagli: ${errorDetail.substring(0, 500)}...`);
            }

            const backendData = await response.json();
            console.log("[FILE] Risposta JSON ricevuta con successo.");

            const allParsedNotes = backendData.allParsedNotes || [];
             if (!backendData.metadata) {
                 console.warn("[FILE] Metadati mancanti nella risposta backend.");
                 backendData.metadata = {};
             }
            console.log(`[FILE] Ricevute ${allParsedNotes.length} note individuali dal backend.`);

            vexflowData = generateVexflowJson(backendData.metadata, allParsedNotes);

            if (vexflowData && vexflowData.measures?.length > 0) {
                 console.log("[FILE] Generazione VexFlow JSON completata. Disegno partitura...");
                drawMusicSheetFromJson(vexflowData);
            } else {
                 const message = allParsedNotes.length === 0 ? "Il file MIDI non contiene note valide per il disegno." : "Errore durante la preparazione dei dati per il disegno. Controlla la console.";
                 alert(message);
                 container.innerHTML = `<p>${message}</p>`;
                 if(statusDisplay) statusDisplay.textContent = message;
                 console.warn("[FILE] Impossibile disegnare partitura. Dati non validi o note mancanti.");
                 disableButtons();
                 accuracyDisplay.textContent = "Accuratezza: N/A";
            }

        } catch (error) {
            console.error("[FILE] Errore generale elaborazione:", error);
            alert(`Si è verificato un errore durante l'elaborazione del file: ${error.message}. Controlla la console.`);
            container.innerHTML = `<p>Errore: ${error.message}</p>`;
            if(statusDisplay) statusDisplay.textContent = `Errore: ${error.message}`;
            disableButtons();
             accuracyDisplay.textContent = "Accuratezza: N/A";
        }
    };
    reader.readAsDataURL(file);
}

function mapTickablesToSvgElements() {
    console.log("[DRAW] Tentativo di mappare tickables agli elementi SVG...");
     svgElementsMap.clear();

     const svg = container.querySelector('svg');
     if (!svg) {
         console.warn("[DRAW] Elemento SVG non trovato per il mapping.");
         return;
     }

     const vexflowCanvas = svg.querySelector('.vexflow-canvas');
     if (!vexflowCanvas) {
         console.warn("[DRAW] Gruppo .vexflow-canvas non trovato per il mapping.");
         return;
     }

     const allSvgGElements = Array.from(vexflowCanvas.querySelectorAll('g'));

     const tickableToSvgElementMap = new Map();
     let svgElementIndex = 0;

     if (vexflowData && vexflowData.measures) {
         vexflowData.measures.forEach(measureData => {
             ['treble', 'bass'].forEach(staveType => {
                 const tickables = measureData.staves[staveType];

                 tickables.forEach(tickable => {
                    if (svgElementIndex < allSvgGElements.length) {
                         const gElement = allSvgGElements[svgElementIndex];
                         tickableToSvgElementMap.set(tickable, gElement);
                         svgElementIndex++;
                    } else {
                         console.warn(`[DRAW] Meno elementi SVG (<g>) del previsto per i tickables. Saltato mapping per tickable.`);
                    }
                 });
             });
         });
     }

     svgElementsMap.clear();

     tickableToSvgElementMap.forEach((svgElement, tickable) => {
         const originalNotesGroup = tickable.originalNotes;

         if (originalNotesGroup && originalNotesGroup.length > 0) {
             originalNotesGroup.forEach(originalNoteData => {
                 svgElementsMap.set(originalNoteData.id, svgElement);
             });
         } else if (tickable instanceof Vex.Flow.StaveNote && tickable.isRest()) {
         } else {
             console.warn(`[DRAW] Original notes data missing for tickable. Cannot map to SVG element.`);
         }
     });


     console.log(`[DRAW] Mapping completo. Mappati ${svgElementsMap.size} ID nota a elementi SVG.`);
}


function highlightCurrentNote(noteData) {
     removeHighlightClasses();

     if (!noteData || !noteData.id) {
          console.warn("[HIGHLIGHT] Dati nota non validi per evidenziazione.");
          return;
     }

     const svgElementToHighlight = svgElementsMap.get(noteData.id);

     if (svgElementToHighlight) {
          svgElementToHighlight.classList.add('current-note-highlight');

          const containerRect = container.getBoundingClientRect();
          const elementRect = svgElementToHighlight.getBoundingClientRect();

          const relativeTop = elementRect.top - containerRect.top + container.scrollTop;
          const relativeBottom = elementRect.bottom - containerRect.top + container.scrollTop;

          if (relativeTop < container.scrollTop + containerRect.height * 0.1) {
              container.scrollTop = relativeTop - containerRect.height * 0.2;
          } else if (relativeBottom > container.scrollTop + containerRect.height * 0.9) {
              container.scrollTop = relativeBottom - containerRect.height + containerRect.height * 0.2;
          }

     } else {
         console.warn(`[HIGHLIGHT] Non è stato possibile trovare l'elemento SVG corrispondente alla nota ID ${noteData.id} per l'evidenziazione.`);
     }
}

function flashIncorrectNote(noteData) {
    if (!noteData || !noteData.id) return;

    const svgElement = svgElementsMap.get(noteData.id);
    if (svgElement) {
        svgElement.classList.add('incorrect-note-flash');
        setTimeout(() => {
            if (!svgElement.classList.contains('correct-note')) {
                 svgElement.classList.remove('incorrect-note-flash');
            }
        }, 500);
    } else {
         console.warn(`[FLASH] Impossibile trovare elemento SVG per flash nota errata ID ${noteData.id}.`);
    }
}

function handleUserNoteInput(midiNumber) {
    lastUserMidiInput = midiNumber;
    if (playbackInterval !== null && currentNoteIndex < allParsedNotesFlattened.length) {
        const expectedNote = allParsedNotesFlattened[currentNoteIndex];

        const chordNotes = allParsedNotesFlattened.filter(note =>
             note.ticks === expectedNote.ticks &&
             note.vexflowTickable === expectedNote.vexflowTickable
        );

        const isCorrect = chordNotes.some(note => note.midi === midiNumber);

        if (isCorrect) {
            console.log(`[INPUT] Corretto! Suonata nota MIDI ${midiNumber} (attesa una tra ${chordNotes.map(n => n.midi).join(', ')}).`);
            correctNotesCount++;
            updateAccuracyDisplay();

             const svgElement = svgElementsMap.get(expectedNote.vexflowTickable.originalNotes[0].id);
             if (svgElement) {
                 svgElement.classList.remove('current-note-highlight');
                 svgElement.classList.add('correct-note');
             } else {
                  console.warn(`[INPUT] Impossibile trovare elemento SVG per marcare come corretto tickable per nota ID ${expectedNote.id}.`);
             }


            currentNoteIndex++;

            if (currentNoteIndex < allParsedNotesFlattened.length) {
                highlightCurrentNote(allParsedNotesFlattened[currentNoteIndex]);
            } else {
                stopPlayback();
                if(statusDisplay) statusDisplay.textContent = "Esercizio completato!";
                console.log("[EXERCISE] Esercizio completato.");
            }

        } else {
            console.log(`[INPUT] Errato. Suonata nota MIDI ${midiNumber}, attesa una tra ${chordNotes.map(n => n.midi).join(', ')}.`);
            flashIncorrectNote(expectedNote.vexflowTickable.originalNotes[0]);
        }
    } else {
         console.log(`[INPUT] Input MIDI ${midiNumber} ricevuto, ma esercizio non attivo.`);
    }
}

function enableButtons() {
    if (playButton) playButton.disabled = false;
    if (stopButton) stopButton.disabled = false;
     if (exportPngButton && container.querySelector('svg')) exportPngButton.disabled = false;
     if (speedSlider) speedSlider.disabled = false;
}

function disableButtons() {
    if (playButton) playButton.disabled = true;
    if (stopButton) stopButton.disabled = true;
    if (exportPngButton) exportPngButton.disabled = true;
    if (speedSlider) speedSlider.disabled = true;
}

function updateAccuracyDisplay() {
    if (accuracyDisplay) {
        if (totalNotesInExercise > 0) {
            const percentage = (correctNotesCount / totalNotesInExercise) * 100;
            accuracyDisplay.textContent = `Accuratezza: ${correctNotesCount}/${totalNotesInExercise} (${percentage.toFixed(0)}%)`;
        } else {
            accuracyDisplay.textContent = "Accuratezza: N/A";
        }
    }
}

function startPlayback() {
    if (!allParsedNotesFlattened || allParsedNotesFlattened.length === 0) {
        console.warn("[PLAYBACK] Nessuna nota da riprodurre.");
         if (statusDisplay) statusDisplay.textContent = "Nessuna nota trovata per l'esercizio.";
        return;
    }

     stopPlayback();
     removeHighlightClasses();
     currentNoteIndex = 0;
     correctNotesCount = 0;

    if(statusDisplay) statusDisplay.textContent = "Esercizio in corso...";

    highlightCurrentNote(allParsedNotesFlattened[currentNoteIndex]);
    updateAccuracyDisplay();

    console.log("[PLAYBACK] Esercizio avviato. Attesa input utente per la prima nota.");
}

function stopPlayback() {
    if (playbackInterval !== null) {
        clearInterval(playbackInterval);
        playbackInterval = null;
        console.log("[PLAYBACK] Esercizio fermato.");
    }
    removeHighlightClasses();
     currentNoteIndex = -1;
     if(statusDisplay && !statusDisplay.textContent.includes("completato")) {
         statusDisplay.textContent = "Esercizio fermato.";
     }
}

function updateSpeedDisplay(value) {
     const speedMap = {
        1: "Molto Lenta", 2: "Lenta", 3: "Moderata",
        4: "Normale", 5: "Normale",
        6: "Media Veloce", 7: "Veloce", 8: "Molto Veloce",
        9: "Presto", 10: "Prestissimo"
     };
     if (speedValueSpan) {
          speedValueSpan.textContent = speedMap[value] || "Normale";
     }
}

async function exportPentagrammaAsPNG() {
    const svgElement = container.querySelector('svg');
    if (!svgElement) {
        alert("Nessun pentagramma da esportare!");
        return;
    }

     if(statusDisplay) statusDisplay.textContent = "Esportazione in corso...";
     exportPngButton.disabled = true;

    try {
        const canvas = await html2canvas(container, {
            scale: 3,
            logging: false,
            useCORS: true
        });

        const imgData = canvas.toDataURL('image/png');
        const link = document.createElement('a');
        link.download = 'partitura.png';
        link.href = imgData;

        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        console.log("[EXPORT] Partitura esportata come PNG.");
        if(statusDisplay) statusDisplay.textContent = "Esportazione completata!";

    } catch (e) {
        console.error("[EXPORT] Errore durante l'esportazione PNG:", e);
        alert("Errore durante l'esportazione della partitura.");
         if(statusDisplay) statusDisplay.textContent = "Erro esportazione.";
    } finally {
         exportPngButton.disabled = false;
    }
}

function init() {
    console.log("[INIT] Inizializzazione...");
    if (!container || !fileInput || !statusDisplay || !playButton || !stopButton || !exportPngButton || !speedSlider || !speedValueSpan || !accuracyDisplay) {
        console.error("Elementi UI principali non trovati!");
        alert("Errore interfaccia. Ricarica la pagina.");
        disableButtons();
        return;
    }

    setupRenderer();
    disableButtons();

    fileInput.addEventListener('change', handleFileSelect, false);
    playButton.addEventListener('click', startPlayback);
    stopButton.addEventListener('click', stopPlayback);
    exportPngButton.addEventListener('click', exportPentagrammaAsPNG);

    speedSlider.addEventListener('input', (event) => {
         updateSpeedDisplay(event.target.value);
    });
     updateSpeedDisplay(speedSlider.value);

    window.simulateMidiInput = (midiNumber) => {
         handleUserNoteInput(midiNumber);
    };
    console.log("DEBUG: Puoi simulare input MIDI chiamando simulateMidiInput(midiNumber) nella console.");

    if(statusDisplay) statusDisplay.textContent = "Carica un file MIDI.";
    console.log("[INIT] Inizializzazione completata.");
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}