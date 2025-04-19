// --- VexFlow Setup ---
const { Renderer, Stave, StaveNote, Beam, Formatter, StaveConnector, Voice, Accidental, Dot, TickContext, Barline } = Vex.Flow;
const VF = Vex.Flow;

// --- Elementi DOM ---
const container = document.getElementById('pentagramma-container');
const fileInput = document.getElementById('midi-file-input');
const accuracyDisplay = document.getElementById('accuracy-display');
const playButton = document.getElementById('play-button');
const stopButton = document.getElementById('stop-button');
const playbackStatus = document.getElementById('playback-status');
const exportPngButton = document.getElementById('export-png-button'); // <<< NUOVO

// --- Costanti Configurabili ---
const STAVE_WIDTH = 280; // <<< RIDOTTO per fare spazio a 4 battute
const MEASURES_PER_LINE = 4; // <<< AUMENTATO a 4 battute per riga
const STAVE_VERTICAL_SPACING = 120;
const SYSTEM_VERTICAL_SPACING = 250;
const STAVE_START_X = 15;
const NOTE_SPLIT_POINT = 60; // Middle C

// --- Stato Applicazione ---
let midiAccess = null; let parsedMidi = null; let vexflowJsonData = null;
let allParsedNotes = [];         // Array originale completo { id, midi, ticks, ..., played }
let trebleNotes = [];            // Array note solo Treble, ordinate per tick
let bassNotes = [];              // Array note solo Bass, ordinate per tick
let vexflowNotesMap = new Map(); // ID -> Oggetto VexNote
let svgElementMap = new Map();   // ID -> Elemento SVG

// --- Stato per Flussi Indipendenti ---
let nextTrebleNoteIndex = 0;     // Indice prossima nota attesa in trebleNotes
let nextBassNoteIndex = 0;       // Indice prossima nota attesa in bassNotes
let activeTrebleNoteID = null;   // ID nota attiva Treble
let activeBassNoteID = null;     // ID nota attiva Bass

// --- Stato Generale ---
let correctNotesCount = 0; let totalNotesInSong = 0; let renderer = null; let context = null; let ppq = 480;
let midiTempo = 500000; // Memorizza tempo letto dal MIDI (microsec per quarter note)

// --- Stato Playback Audio/Visuale ---
let audioCtx = null; // Web Audio Context
let isPlaying = false; // Flag per playback
let scheduledVisuals = []; // Array per ID timeout visuali (per stop)
let activeOscillators = []; // Array per riferimenti agli oscillatori (per stop)
let masterGainNode = null; // Nodo Gain principale per controllo volume/stop


// --- Funzioni Utilità (ticksToVexflowDuration, midiNumberToVexflowNote, groupNotesByMeasure) ---
function ticksToVexflowDuration(ticks) { const q = ppq; if (q <= 0) return { duration: "16", dots: 0 }; const t = 0.90; if (ticks >= q*4*t) return { duration: "w", dots: 0 }; if (ticks >= q*3*t) return { duration: "h", dots: 1 }; if (ticks >= q*2*t) return { duration: "h", dots: 0 }; if (ticks >= q*1.5*t) return { duration: "q", dots: 1 }; if (ticks >= q*1*t) return { duration: "q", dots: 0 }; if (ticks >= q*0.75*t) return { duration: "8", dots: 1 }; if (ticks >= q*0.5*t) return { duration: "8", dots: 0 }; if (ticks >= q*0.375*t) return { duration: "16", dots: 1 }; if (ticks >= q*0.25*t) return { duration: "16", dots: 0 }; if (ticks >= q*0.125*t) return { duration: "32", dots: 0 }; return { duration: "16", dots: 0 }; }
function midiNumberToVexflowNote(midiNumber) { const n = ["c","c#","d","d#","e","f","f#","g","g#","a","a#","b"]; const o = Math.floor(midiNumber / 12) - 1; const i = midiNumber % 12; return `${n[i]}/${o}`; }
function groupNotesByMeasure(notes, timeSignature, ppqInput) { if (!timeSignature || !Array.isArray(timeSignature) || timeSignature.length < 2 || !ppqInput || ppqInput <= 0) { timeSignature = [4, 4]; ppqInput = 480; } let [beats, unit] = timeSignature; if (typeof unit !== 'number' || unit <= 0 || Math.log2(unit) % 1 !== 0) { unit = 4; } const ticksPerBeat = ppqInput * (4 / unit); const ticksPerMeasure = ticksPerBeat * beats; if (ticksPerMeasure <= 0) { return [notes]; } const measures = []; let currentNotes = []; let currentIdx = 0; notes.forEach(note => { const epsilon = 1; const noteStartIdx = Math.floor((note.ticks + epsilon) / ticksPerMeasure); while (currentIdx < noteStartIdx) { measures.push(currentNotes); currentNotes = []; currentIdx++; } currentNotes.push(note); }); measures.push(currentNotes); return measures; }

// --- Conversione da Struttura MidiParser a JSON per VexFlow ---
function convertMidiDataToJson(parsedMidiData) {
    if (!parsedMidiData || !parsedMidiData.track) { console.error("[CONVERT] Dati MidiParser non validi."); return null; }
    let timeSig = [4, 4], keySig = "C", localPpq = 480, tempo = 500000; if (typeof parsedMidiData.timeDivision === 'number' && parsedMidiData.timeDivision > 0) localPpq = parsedMidiData.timeDivision; else if (Array.isArray(parsedMidiData.timeDivision)) console.warn("[CONVERT] Modalità SMPTE rilevata."); ppq = localPpq;
    if (parsedMidiData.track[0]?.event) { for (const event of parsedMidiData.track[0].event) { if (event.type === 0xFF) { if (event.metaType === 0x58 && event.data?.length >= 2) { const d = Math.pow(2, event.data[1]); if (d > 0) timeSig = [event.data[0], d]; } else if (event.metaType === 0x59) keySig = "C"; else if (event.metaType === 0x51 && typeof event.data === 'number') tempo = event.data; } } }
    midiTempo = tempo; // Salva tempo per playback
    const timeSigStr = `${timeSig[0]}/${timeSig[1]}`; let ticks = 0; const notesInProgress = {}; const finishedNotes = [];
    parsedMidiData.track.forEach((track, trackIndex) => {
        ticks = 0;
        track.event.forEach((event, eventIndex) => {
            ticks += event.deltaTime; const type = event.type; const ch = event.channel;
            if (type === 9 && event.data?.[1] > 0) { const note = event.data[0], vel = event.data[1], key = `${ch}_${note}`, id = `vf-t${trackIndex}-e${eventIndex}-m${note}`; if (notesInProgress[key]) delete notesInProgress[key]; notesInProgress[key] = { note: { id, midi: note, ticks, durationTicks: 0, vexNoteName: midiNumberToVexflowNote(note), track: trackIndex, channel: ch, velocity: vel }, startTime: ticks }; }
            else if (type === 8 || (type === 9 && event.data?.[1] === 0)) { const note = event.data[0], key = `${ch}_${note}`; if (notesInProgress[key]) { const finNote = notesInProgress[key]; finNote.note.durationTicks = ticks - finNote.startTime; if (finNote.note.durationTicks > 0) finishedNotes.push(finNote.note); else console.warn(`[PARSE] Nota ${finNote.note.id} scartata (durata <= 0).`); delete notesInProgress[key]; } }
        });
        Object.keys(notesInProgress).forEach(key => { if (notesInProgress[key]?.note.track === trackIndex) { console.warn(`[PARSE] Nota ${key} (ID: ${notesInProgress[key].note.id}) appesa. Ignorata.`); delete notesInProgress[key]; } });
    });
    finishedNotes.sort((a, b) => a.ticks - b.ticks); allParsedNotes = finishedNotes.map(n => ({ ...n, played: false })); console.log(`[CONVERT] Note MIDI estratte: ${allParsedNotes.length}`);
    trebleNotes = allParsedNotes.filter(note => note.midi >= NOTE_SPLIT_POINT); bassNotes = allParsedNotes.filter(note => note.midi < NOTE_SPLIT_POINT); console.log(`[CONVERT] Note separate: Treble=${trebleNotes.length}, Bass=${bassNotes.length}`);
    if (allParsedNotes.length === 0) { console.warn("[CONVERT] Nessuna nota valida."); return null; }
    const measuresGrouped = groupNotesByMeasure(allParsedNotes, timeSig, localPpq); const vexflowJson = { metadata: { timeSignature: timeSigStr, keySignature: keySig, ppq: localPpq, tempo: midiTempo }, measures: [] };
    measuresGrouped.forEach((measureNotes) => { const measureJson = { staves: { treble: [], bass: [] } }; measureNotes.forEach(note => { const { duration, dots } = ticksToVexflowDuration(note.durationTicks); const noteJson = { id: note.id, keys: [note.vexNoteName], duration, dots }; if (note.midi < NOTE_SPLIT_POINT) measureJson.staves.bass.push(noteJson); else measureJson.staves.treble.push(noteJson); }); vexflowJson.measures.push(measureJson); });
    return vexflowJson;
}


// --- Funzione di disegno VexFlow da JSON ---
function drawMusicSheetFromJson(vexflowData) {
    console.log("[DEBUG DRAW] Inizio disegno da JSON...");
    setupRenderer(); if (!vexflowData || !vexflowData.measures?.length) { console.error("[DEBUG DRAW] Dati JSON non validi."); container.innerHTML = '<p>Errore dati.</p>'; return; }
    const timeSig = vexflowData.metadata.timeSignature; const keySig = vexflowData.metadata.keySignature; const totalMeasures = vexflowData.measures.length;
    // Usa le costanti aggiornate qui
    const totalLines = Math.ceil(totalMeasures / MEASURES_PER_LINE);
    const totalHeight = totalLines * SYSTEM_VERTICAL_SPACING + 60;
    const totalWidth = STAVE_START_X + (STAVE_WIDTH * MEASURES_PER_LINE) + 50; // Larghezza basata su 4 battute
    renderer.resize(totalWidth, totalHeight); console.log(`[DEBUG DRAW] Renderer resized: ${totalWidth} x ${totalHeight}`); let currentY = 40; const staveLayout = [];
    for (let lineIndex = 0; lineIndex < totalLines; lineIndex++) { let firstStaveOfLine = null; let lastStaveOfLine = null; for (let measureInLine = 0; measureInLine < MEASURES_PER_LINE; measureInLine++) { const measureIndex = lineIndex * MEASURES_PER_LINE + measureInLine; if (measureIndex >= totalMeasures) break; const currentX = STAVE_START_X + (measureInLine * STAVE_WIDTH); const trebleStave = new Stave(currentX, currentY, STAVE_WIDTH); const bassStave = new Stave(currentX, currentY + STAVE_VERTICAL_SPACING, STAVE_WIDTH); if (measureIndex === 0) { trebleStave.addClef("treble").addTimeSignature(timeSig).addKeySignature(keySig); bassStave.addClef("bass").addTimeSignature(timeSig).addKeySignature(keySig); new StaveConnector(trebleStave, bassStave).setType(VF.StaveConnector.type.BRACE).setContext(context).draw(); } if (measureInLine === 0) { new StaveConnector(trebleStave, bassStave).setType(VF.StaveConnector.type.SINGLE_LEFT).setContext(context).draw(); firstStaveOfLine = trebleStave; } lastStaveOfLine = trebleStave; if (measureIndex === totalMeasures - 1) { trebleStave.setEndBarType(VF.Barline.type.END); bassStave.setEndBarType(VF.Barline.type.END); } trebleStave.setContext(context).draw(); bassStave.setContext(context).draw(); staveLayout[measureIndex] = { trebleStave, bassStave }; } if (lastStaveOfLine) { const lIdx = staveLayout.findIndex(p => p?.trebleStave === lastStaveOfLine); if (lIdx !== -1 && staveLayout[lIdx]) { const bS = staveLayout[lIdx].bassStave; new StaveConnector(lastStaveOfLine, bS).setType(VF.StaveConnector.type.SINGLE_RIGHT).setContext(context).draw(); } } currentY += SYSTEM_VERTICAL_SPACING; }
    vexflowNotesMap.clear();
    console.log("[DEBUG DRAW] Inizio creazione VexNotes e mappatura SVG...");
    vexflowData.measures.forEach((measureData, measureIndex) => {
        const stavePair = staveLayout[measureIndex]; if (!stavePair) { console.warn(`[DEBUG DRAW] Staves non trovati per misura ${measureIndex + 1}`); return; } const { trebleStave, bassStave } = stavePair; const trebleNotesVex = []; const bassNotesVex = []; const currentMeasureTrebleNotesInfo = []; const currentMeasureBassNotesInfo = [];

        // Funzione per creare StaveNote con GESTIONE ACCIDENTALI MIRATA
        const createStaveNote = (noteJson, clef) => {
            try {
                const staveNote = new StaveNote({ keys: noteJson.keys, duration: noteJson.duration, clef: clef, auto_stem: true });
                if (noteJson.dots > 0) { for (let d = 0; d < noteJson.dots; d++) Dot.buildAndAttach([staveNote], { index: 0 }); }
                noteJson.keys.forEach((key, index) => { const hasSharp = key.includes("#"); const hasFlat = key.includes("b"); let accTypeToAdd = null; if (hasSharp) { accTypeToAdd = "#"; } else if (hasFlat) { if (!key.startsWith("b/")) { accTypeToAdd = "b"; } } if (accTypeToAdd) { if (!staveNote.modifiers.some(mod => mod instanceof Accidental && mod.getIndex() === index)) { staveNote.addModifier(new Accidental(accTypeToAdd), index); } } });
                vexflowNotesMap.set(noteJson.id, staveNote);
                return staveNote;
            } catch (e) { console.error(`[DEBUG DRAW] Errore creazione StaveNote ID ${noteJson.id}:`, e); return null; }
        };

        measureData.staves.treble.forEach(noteJson => { const noteObj = createStaveNote(noteJson, "treble"); if (noteObj) { trebleNotesVex.push(noteObj); currentMeasureTrebleNotesInfo.push({ id: noteJson.id, vexNote: noteObj }); } });
        measureData.staves.bass.forEach(noteJson => { const noteObj = createStaveNote(noteJson, "bass"); if (noteObj) { bassNotesVex.push(noteObj); currentMeasureBassNotesInfo.push({ id: noteJson.id, vexNote: noteObj }); } });

        const mapSvgElements = (notesInfoArray, staveType) => { if (!context?.svg || notesInfoArray.length === 0) return; const allNoteGroups = Array.from(context.svg.querySelectorAll('g.vf-stavenote')); const startIndex = allNoteGroups.length - notesInfoArray.length; if (startIndex >= 0 && allNoteGroups.length >= notesInfoArray.length) { const newlyAddedNoteGroups = allNoteGroups.slice(startIndex); if (newlyAddedNoteGroups.length === notesInfoArray.length) { notesInfoArray.forEach((noteInfo, idx) => { const svgElement = newlyAddedNoteGroups[idx]; svgElementMap.set(noteInfo.id, svgElement); svgElement.setAttribute('id', noteInfo.id); }); } else { console.warn(`[DEBUG SVG MAP] Misura ${measureIndex+1} ${staveType} - MISMATCH note (${notesInfoArray.length}) vs <g.vf-stavenote> (${newlyAddedNoteGroups.length}). Mappatura fallita.`); } } else { console.warn(`[DEBUG SVG MAP] Misura ${measureIndex+1} ${staveType} - Non trovati abbastanza <g.vf-stavenote> (${allNoteGroups.length}) per mappare ${notesInfoArray.length} note. Mappatura fallita.`); } };
        try { if (trebleNotesVex.length > 0) { const beams = Beam.generateBeams(trebleNotesVex, { stem_direction: VF.Stem.UP }); Formatter.FormatAndDraw(context, trebleStave, trebleNotesVex); mapSvgElements(currentMeasureTrebleNotesInfo, "Treble"); beams.forEach(b => b.setContext(context).draw()); } } catch (e) { console.error(`[DEBUG DRAW] ERRORE Formatter/Draw Treble misura ${measureIndex + 1}:`, e.message, e.stack); }
        try { if (bassNotesVex.length > 0) { const beams = Beam.generateBeams(bassNotesVex, { stem_direction: VF.Stem.DOWN }); Formatter.FormatAndDraw(context, bassStave, bassNotesVex); mapSvgElements(currentMeasureBassNotesInfo, "Bass"); beams.forEach(b => b.setContext(context).draw()); } } catch (e) { console.error(`[DEBUG DRAW] ERRORE Formatter/Draw Bass misura ${measureIndex + 1}:`, e.message, e.stack); }
    });
    console.log(`[DEBUG SVG MAP] Mappatura SVG completata. svgElementMap size: ${svgElementMap.size}`);
    if (svgElementMap.size !== allParsedNotes.length) { console.warn(`[DEBUG SVG MAP] ATTENZIONE: Mappati ${svgElementMap.size} SVG vs ${allParsedNotes.length} note parsate.`); const missingIds = allParsedNotes.filter(note => !svgElementMap.has(note.id)); if (missingIds.length > 0) console.warn(`[DEBUG SVG MAP] IDs note non mappate a SVG:`, missingIds.map(n => n.id)); }
    else { console.log(`[DEBUG SVG MAP] Numero elementi SVG mappati corrisponde a note parsate.`); }
    console.log("[DEBUG DRAW] Partitura disegnata.");
}


// --- Inizializzazione Applicazione ---
function init() {
    console.log("[DEBUG INIT] Inizializzazione applicazione...");
    // Aggiunto exportPngButton al controllo
    if (!playButton || !stopButton || !fileInput || !playbackStatus || !container || !accuracyDisplay || !exportPngButton) {
        console.error("[INIT ERROR] Elementi UI principali non trovati!");
        alert("Errore interfaccia. Ricarica la pagina.");
        return;
    }
    setupRenderer();
    requestMIDIAccess();
    fileInput.addEventListener('change', handleFileSelect, false);
    playButton.addEventListener('click', playMidi);
    stopButton.addEventListener('click', stopPlayback);
    exportPngButton.addEventListener('click', exportSheetAsPNG); // <<< NUOVO LISTENER

    console.log("[DEBUG INIT] Applicazione inizializzata e pronta.");
}

// --- Setup Renderer VexFlow ---
function setupRenderer() {
    container.innerHTML = ''; vexflowNotesMap.clear(); svgElementMap.clear(); // Pulisci mappe
    renderer = new Renderer(container, Renderer.Backends.SVG); renderer.resize(STAVE_START_X + (STAVE_WIDTH * MEASURES_PER_LINE) + 50, 200); context = renderer.getContext(); context.setFont('Arial', 10).setBackgroundFillStyle('#fff');
}

// --- Gestione Selezione File MIDI ---
async function handleFileSelect(event) {
    stopPlayback(); const file = event.target.files[0]; if (!file) return; console.log(`[DEBUG FILE] Caricamento file: ${file.name}`); container.innerHTML = '<p>Caricamento e analisi...</p>'; updateAccuracyDisplay(true); if(playButton) playButton.disabled = true; if(stopButton) stopButton.disabled = true; if(playbackStatus) playbackStatus.textContent = ""; if(exportPngButton) exportPngButton.disabled = true; // <<< DISABILITA ESPORTA
    const reader = new FileReader();
    reader.onload = async (e) => {
        console.log("[DEBUG FILE] File letto.");
        try {
            const midiUint8Array = new Uint8Array(e.target.result); console.log("[DEBUG FILE] Parsing MIDI..."); if (typeof MidiParser === 'undefined') throw new Error("MidiParser non trovato!"); parsedMidi = MidiParser.Uint8(midiUint8Array); if (!parsedMidi) { console.error("[DEBUG FILE] Parsing fallito."); alert("Errore parsing MIDI."); container.innerHTML = '<p>Errore parsing.</p>'; updateAccuracyDisplay(true); return; }
            console.log("[DEBUG FILE] Parsing completato. Conversione in JSON..."); vexflowJsonData = convertMidiDataToJson(parsedMidi);
            totalNotesInSong = allParsedNotes.length; correctNotesCount = 0; nextTrebleNoteIndex = 0; nextBassNoteIndex = 0; activeTrebleNoteID = null; activeBassNoteID = null;
            console.log(`[DEBUG FILE] Reset stato: totalNotes=${totalNotesInSong}`);
            if (vexflowJsonData && totalNotesInSong > 0) {
                console.log(`[DEBUG FILE] Dati pronti (${totalNotesInSong} note). Chiamata a drawMusicSheetFromJson...`); updateAccuracyDisplay(); drawMusicSheetFromJson(vexflowJsonData);
                console.log("[DEBUG FILE] Attesa breve per rendering...");
                setTimeout(() => {
                    console.log(`[DEBUG FILE] Impostazione e highlight note iniziali...`);
                    setActiveNotes();
                    highlightActiveNotes();
                    if(playButton) playButton.disabled = false;
                    if(exportPngButton) exportPngButton.disabled = false; // <<< ABILITA ESPORTA
                    console.log("[DEBUG FILE] Partitura pronta per interazione e playback.");
                }, 150); // Leggero ritardo per assicurare il rendering SVG prima di interagire
            } else {
                console.warn("[DEBUG FILE] Nessun dato valido da disegnare.");
                alert(totalNotesInSong === 0 ? "Il file non contiene note." : "Errore conversione dati.");
                container.innerHTML = `<p>${totalNotesInSong === 0 ? 'Nessuna nota nel file.' : 'Errore conversione.'}</p>`;
                updateAccuracyDisplay(true);
                if(exportPngButton) exportPngButton.disabled = true; // <<< MANTIENI DISABILITATO
            }
        } catch (error) {
            console.error("[DEBUG FILE] Errore grave processo file:", error);
            alert(`Errore elaborazione file: ${error.message}`);
            container.innerHTML = `<p>Errore: ${error.message}</p>`;
            updateAccuracyDisplay(true);
            if(exportPngButton) exportPngButton.disabled = true; // <<< MANTIENI DISABILITATO
        }
    };
    reader.onerror = (err) => { console.error("[DEBUG FILE] Errore lettura file:", err); alert("Impossibile leggere il file."); updateAccuracyDisplay(true); if(exportPngButton) exportPngButton.disabled = true; }; // <<< MANTIENI DISABILITATO
    reader.readAsArrayBuffer(file);
}


// --- Gestione Input MIDI ---
function requestMIDIAccess() { if (navigator.requestMIDIAccess) { navigator.requestMIDIAccess({ sysex: false }).then(onMIDISuccess, onMIDIFailure); } else { console.warn("[DEBUG MIDI] Web MIDI API non supportata."); alert("Web MIDI non supportata."); } }
function onMIDISuccess(midi) { console.log("[DEBUG MIDI] Accesso MIDI Riuscito!"); midiAccess = midi; const inputs = midiAccess.inputs.values(); let found = false; for (let input = inputs.next(); input && !input.done; input = inputs.next()) { const mi = input.value; console.log(`[DEBUG MIDI] Input trovato: ${mi.name}`); mi.onmidimessage = onMIDIMessage; found = true; } if (!found) console.warn("[DEBUG MIDI] Nessun input MIDI trovato."); midiAccess.onstatechange = (event) => { const p = event.port; console.log(`[DEBUG MIDI] Stato MIDI cambiato: ${p.name} -> ${p.state}`); if (p.type === "input" && p.state === "connected" && !p.onmidimessage) p.onmidimessage = onMIDIMessage; else if (p.type === "input" && p.state === "disconnected") p.onmidimessage = null; }; }
function onMIDIFailure(msg) { console.error(`[DEBUG MIDI] Accesso MIDI Fallito: ${msg}`); alert(`Accesso MIDI Fallito: ${msg}.`); }
function onMIDIMessage(event) { if (!event?.data || event.data.length < 3) return; const status = event.data[0]; const command = status >> 4; const noteNumber = event.data[1]; const velocity = event.data[2]; if (command === 9 && velocity > 0) { handlePlayedNote(noteNumber); } }

// --- Logica di Gioco/Interazione (Flussi Indipendenti) ---
function setActiveNotes() {
    let foundTreble = false; while (nextTrebleNoteIndex < trebleNotes.length) { const note = trebleNotes[nextTrebleNoteIndex]; const fullNoteInfo = allParsedNotes.find(n => n.id === note.id); if (fullNoteInfo && !fullNoteInfo.played) { activeTrebleNoteID = note.id; foundTreble = true; break; } nextTrebleNoteIndex++; } if (!foundTreble) activeTrebleNoteID = null;
    let foundBass = false; while (nextBassNoteIndex < bassNotes.length) { const note = bassNotes[nextBassNoteIndex]; const fullNoteInfo = allParsedNotes.find(n => n.id === note.id); if (fullNoteInfo && !fullNoteInfo.played) { activeBassNoteID = note.id; foundBass = true; break; } nextBassNoteIndex++; } if (!foundBass) activeBassNoteID = null;
    checkEndOfSong();
}
function handlePlayedNote(playedMidiNoteNumber) {
    let noteProcessed = false;
    if (activeTrebleNoteID) { const activeTrebleNote = trebleNotes[nextTrebleNoteIndex]; if (activeTrebleNote && activeTrebleNote.id === activeTrebleNoteID && activeTrebleNote.midi === playedMidiNoteNumber) { console.log(`CORRETTO (Treble)! Nota ${activeTrebleNote.vexNoteName} (MIDI ${activeTrebleNote.midi})`); const fullNoteInfo = allParsedNotes.find(n => n.id === activeTrebleNoteID); if (fullNoteInfo && !fullNoteInfo.played) { correctNotesCount++; fullNoteInfo.played = true; } markNoteAsCorrect(activeTrebleNote); nextTrebleNoteIndex++; setActiveNotes(); highlightActiveNotes(); noteProcessed = true; } }
    if (activeBassNoteID && !noteProcessed) { const activeBassNote = bassNotes[nextBassNoteIndex]; if (activeBassNote && activeBassNote.id === activeBassNoteID && activeBassNote.midi === playedMidiNoteNumber) { console.log(`CORRETTO (Bass)! Nota ${activeBassNote.vexNoteName} (MIDI ${activeBassNote.midi})`); const fullNoteInfo = allParsedNotes.find(n => n.id === activeBassNoteID); if (fullNoteInfo && !fullNoteInfo.played) { correctNotesCount++; fullNoteInfo.played = true; } markNoteAsCorrect(activeBassNote); nextBassNoteIndex++; setActiveNotes(); highlightActiveNotes(); noteProcessed = true; } }
    if (!noteProcessed) { const playedName = midiNumberToVexflowNote(playedMidiNoteNumber); let expectedStr = ""; if (activeTrebleNoteID) { const note = trebleNotes[nextTrebleNoteIndex]; expectedStr += `${note?.vexNoteName}(${note?.midi})` } if (activeBassNoteID) { const note = bassNotes[nextBassNoteIndex]; expectedStr += (expectedStr ? " o " : "") + `${note?.vexNoteName}(${note?.midi})` } console.log(`SBAGLIATO. Suonato: ${playedName} (${playedMidiNoteNumber}), Atteso: ${expectedStr || 'Nessuna nota attiva?'}`); if (activeTrebleNoteID) { const note = trebleNotes[nextTrebleNoteIndex]; if(note) markNoteAsIncorrect(note); } if (activeBassNoteID) { const note = bassNotes[nextBassNoteIndex]; if(note) markNoteAsIncorrect(note); } }
    updateAccuracyDisplay();
}
function checkEndOfSong() { if (activeTrebleNoteID === null && activeBassNoteID === null) { if (nextTrebleNoteIndex >= trebleNotes.length && nextBassNoteIndex >= bassNotes.length) { console.log("[DEBUG END] --- BRANO COMPLETATO! ---"); const finalAccuracy = calculateAccuracy(); updateAccuracyDisplay(); setTimeout(()=> { alert(`Complimenti! Accuratezza finale: ${finalAccuracy}%.`); }, 100); } } }

// --- Funzioni di Modifica Visiva (USANO svgElementMap) ---
function markNoteAsCorrect(noteInfo) { if (!noteInfo?.id) return; const svgGroup = svgElementMap.get(noteInfo.id); if (svgGroup) { svgGroup.classList.remove('current-note-highlight', 'incorrect-note-flash', 'playback-highlight'); svgGroup.classList.add('correct-note'); } else { console.warn(`[VISUAL WARN] SVG per ID "${noteInfo.id}" non trovato (correct).`); } }
function markNoteAsIncorrect(noteInfo) { if (!noteInfo?.id) return; const svgGroup = svgElementMap.get(noteInfo.id); if (svgGroup) { svgGroup.classList.add('incorrect-note-flash'); setTimeout(() => { if (svgGroup?.classList) svgGroup.classList.remove('incorrect-note-flash'); }, 500); } else { console.warn(`[VISUAL WARN] SVG per ID "${noteInfo.id}" non trovato (incorrect).`); } }
function highlightActiveNotes() {
    svgElementMap.forEach(element => element.classList.remove('current-note-highlight')); let firstElementToScroll = null;
    if (activeTrebleNoteID) { const svgGroup = svgElementMap.get(activeTrebleNoteID); if (svgGroup) { svgGroup.classList.add('current-note-highlight'); if (!firstElementToScroll && container.scrollHeight > container.clientHeight) { const cRect = container.getBoundingClientRect(); const nRect = svgGroup.getBoundingClientRect(); const b = 50; if (nRect.top < cRect.top + b || nRect.bottom > cRect.bottom - b) firstElementToScroll = svgGroup; } } else { console.warn(`[VISUAL WARN] SVG per ID Treble "${activeTrebleNoteID}" non trovato (highlight).`); } }
    if (activeBassNoteID) { const svgGroup = svgElementMap.get(activeBassNoteID); if (svgGroup) { svgGroup.classList.add('current-note-highlight'); if (!firstElementToScroll && container.scrollHeight > container.clientHeight) { const cRect = container.getBoundingClientRect(); const nRect = svgGroup.getBoundingClientRect(); const b = 50; if (nRect.top < cRect.top + b || nRect.bottom > cRect.bottom - b) firstElementToScroll = svgGroup; } } else { console.warn(`[VISUAL WARN] SVG per ID Bass "${activeBassNoteID}" non trovato (highlight).`); } }
    if (firstElementToScroll) { const cRect = container.getBoundingClientRect(); const nRect = firstElementToScroll.getBoundingClientRect(); const nTopRel = nRect.top - cRect.top + container.scrollTop; const dScroll = nTopRel - (container.clientHeight / 3); const maxScroll = container.scrollHeight - container.clientHeight; const fScroll = Math.max(0, Math.min(dScroll, maxScroll)); container.scrollTo({ top: fScroll, behavior: 'smooth' }); }
}

// --- NUOVE FUNZIONI PER PLAYBACK AUDIO ---
function initAudio() { if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); masterGainNode = audioCtx.createGain(); masterGainNode.connect(audioCtx.destination); masterGainNode.gain.setValueAtTime(0.7, audioCtx.currentTime); console.log("[AUDIO] AudioContext inizializzato."); } catch (e) { console.error("[AUDIO] Web Audio API non supportata.", e); alert("Web Audio API non supportata."); return false; } } if (audioCtx.state === 'suspended') audioCtx.resume(); return true; }
function midiToFreq(midiNote) { return 440 * Math.pow(2, (midiNote - 69) / 12); }
function playMidi() {
    if (isPlaying) return; if (!allParsedNotes?.length) return; if (!initAudio()) return;
    console.log("[AUDIO] Avvio Playback..."); isPlaying = true; if(playButton) playButton.disabled = true; if(stopButton) stopButton.disabled = false; if(playbackStatus) playbackStatus.textContent = "Riproduzione..."; scheduledVisuals = []; activeOscillators = [];
    if (ppq <= 0) { console.error("[AUDIO] PPQ non valido."); stopPlayback(); return; }
    const secondsPerBeat = midiTempo / 1000000; const secondsPerTick = secondsPerBeat / ppq; console.log(`[AUDIO] Tempo: ${midiTempo} us/beat, PPQ: ${ppq}, Sec/Tick: ${secondsPerTick}`);
    const playbackStartTime = audioCtx.currentTime; let lastNoteEndTime = 0;
    svgElementMap.forEach(element => element.classList.remove('current-note-highlight', 'correct-note', 'incorrect-note-flash', 'playback-highlight')); // Pulisci tutti gli stili
    allParsedNotes.forEach(note => {
        const noteStartTimeSec = note.ticks * secondsPerTick; const noteDurationSec = Math.max(0.05, note.durationTicks * secondsPerTick); const absoluteStartTime = playbackStartTime + noteStartTimeSec; const absoluteStopTime = absoluteStartTime + noteDurationSec; const frequency = midiToFreq(note.midi);
        const oscillator = audioCtx.createOscillator(); const gainNode = audioCtx.createGain(); oscillator.type = 'triangle'; oscillator.frequency.setValueAtTime(frequency, absoluteStartTime); gainNode.gain.setValueAtTime(0.5, absoluteStartTime); gainNode.gain.linearRampToValueAtTime(0, absoluteStopTime); oscillator.connect(gainNode); gainNode.connect(masterGainNode);
        oscillator.start(absoluteStartTime); oscillator.stop(absoluteStopTime); activeOscillators.push(oscillator);
        const visualTimeoutId = setTimeout(() => { playbackHighlightNote(note.id); }, noteStartTimeSec * 1000); scheduledVisuals.push(visualTimeoutId);
        if (absoluteStopTime > lastNoteEndTime) lastNoteEndTime = absoluteStopTime;
    });
    const endDelayMs = (lastNoteEndTime - playbackStartTime) * 1000 + 200; const endTimeoutId = setTimeout(() => { console.log("[AUDIO] Playback terminato."); stopPlayback(false); }, endDelayMs); scheduledVisuals.push(endTimeoutId);
    console.log(`[AUDIO] ${allParsedNotes.length} note programmate. Durata stimata: ${(lastNoteEndTime - playbackStartTime).toFixed(2)}s`);
}
function stopPlayback(resetUserInteraction = true) {
    if (!isPlaying && scheduledVisuals.length === 0) return; console.log("[AUDIO] Stop Playback richiesto..."); isPlaying = false;
    activeOscillators.forEach(osc => { try { osc.stop(audioCtx.currentTime); } catch (e) { /* Ignora */ } }); activeOscillators = [];
    scheduledVisuals.forEach(timeoutId => clearTimeout(timeoutId)); scheduledVisuals = [];
    svgElementMap.forEach(element => element.classList.remove('playback-highlight')); // Rimuovi solo highlight playback
    if(playButton) playButton.disabled = (allParsedNotes.length === 0); if(stopButton) stopButton.disabled = true; if(playbackStatus) playbackStatus.textContent = "";
    if (resetUserInteraction && allParsedNotes.length > 0) { // Aggiunto controllo allParsedNotes
         console.log("[AUDIO] Reset interazione utente.");
         highlightActiveNotes(); // Ri-evidenzia note interattive solo se c'è una partitura
    }
}
function playbackHighlightNote(noteId) {
    if (!isPlaying) return; svgElementMap.forEach(element => element.classList.remove('playback-highlight')); const svgGroup = svgElementMap.get(noteId);
    if (svgGroup) { svgGroup.classList.add('playback-highlight'); if (container.scrollHeight > container.clientHeight) { const cRect = container.getBoundingClientRect(); const nRect = svgGroup.getBoundingClientRect(); const b = 50; if (nRect.top < cRect.top + b || nRect.bottom > cRect.bottom - b) { const nTopRel = nRect.top - cRect.top + container.scrollTop; const dScroll = nTopRel - (container.clientHeight / 3); const maxScroll = container.scrollHeight - container.clientHeight; const fScroll = Math.max(0, Math.min(dScroll, maxScroll)); container.scrollTo({ top: fScroll, behavior: 'smooth' }); } }
    } // else { console.warn(`[VISUAL PLAYBACK WARN] SVG per ID "${noteId}" non trovato.`); }
}

// --- Funzioni Utilità ---
function updateAccuracyDisplay(reset = false) { if (!accuracyDisplay) return; if (reset || totalNotesInSong === 0) { accuracyDisplay.textContent = "Accuratezza: N/A"; return; } const accuracy = calculateAccuracy(); const progressText = `${correctNotesCount}/${totalNotesInSong}`; accuracyDisplay.textContent = `Accuratezza: ${accuracy}% (${progressText})`; }
function calculateAccuracy() { if (totalNotesInSong === 0) return 0; return Math.round((correctNotesCount / totalNotesInSong) * 100); }

// --- NUOVA FUNZIONE PER ESPORTARE COME PNG ---
function exportSheetAsPNG() {
    const sheetContainer = document.getElementById('pentagramma-container');
    const svgElement = sheetContainer.querySelector('svg'); // Verifica che ci sia un SVG

    if (!svgElement) {
        alert("Nessuna partitura caricata da esportare.");
        return;
    }
    if (typeof html2canvas === 'undefined') {
        alert("Errore: la libreria html2canvas non è stata caricata.");
        console.error("html2canvas non è definito. Controlla l'inclusione dello script in index.html.");
        return;
    }

    console.log("[EXPORT PNG] Avvio esportazione...");
    if(exportPngButton) exportPngButton.disabled = true; // Disabilita durante l'esportazione
    if(playbackStatus) playbackStatus.textContent = "Esportazione PNG...";

    // Opzioni per html2canvas
    const options = {
        scale: 2, // Aumenta la scala per una risoluzione migliore (es. 2x)
        useCORS: true,
        logging: false, // Disabilita i log di html2canvas in console (opzionale)
        backgroundColor: '#ffffff' // Forza sfondo bianco per l'immagine
    };

    // Memorizza gli stili originali per ripristinarli dopo
    const originalOverflowY = sheetContainer.style.overflowY;
    const originalMaxHeight = sheetContainer.style.maxHeight;

    // Modifica temporaneamente lo stile per catturare tutto il contenuto
    sheetContainer.style.overflowY = 'visible';
    sheetContainer.style.maxHeight = 'none';
    // Forza un reflow per assicurarsi che le modifiche siano applicate prima dello screenshot
    void sheetContainer.offsetWidth;

    html2canvas(sheetContainer, options).then(canvas => {
        // Ripristina immediatamente gli stili originali
        sheetContainer.style.overflowY = originalOverflowY;
        sheetContainer.style.maxHeight = originalMaxHeight;

        console.log("[EXPORT PNG] Canvas generato, creazione immagine...");
        const imageURL = canvas.toDataURL('image/png');

        // Crea un link temporaneo per il download
        const downloadLink = document.createElement('a');
        downloadLink.href = imageURL;
        // Prova a usare il nome del file caricato se disponibile, altrimenti usa un default
        const inputFileName = fileInput.files[0]?.name.replace(/\.(mid|midi)$/i, '') || 'partitura';
        downloadLink.download = `${inputFileName}.png`;

        // Simula il click sul link per avviare il download
        document.body.appendChild(downloadLink);
        downloadLink.click();
        document.body.removeChild(downloadLink);

        console.log("[EXPORT PNG] Esportazione completata.");
        if(exportPngButton) exportPngButton.disabled = false; // Riabilita il pulsante
        if(playbackStatus) playbackStatus.textContent = ""; // Pulisci lo stato

    }).catch(error => {
        // Assicurati di ripristinare gli stili anche in caso di errore
        sheetContainer.style.overflowY = originalOverflowY;
        sheetContainer.style.maxHeight = originalMaxHeight;

        console.error("[EXPORT PNG] Errore durante l'esportazione:", error);
        alert("Si è verificato un errore durante l'esportazione dell'immagine PNG.");
        if(exportPngButton) exportPngButton.disabled = false; // Riabilita il pulsante
        if(playbackStatus) playbackStatus.textContent = ""; // Pulisci lo stato
    });
}


// --- Avvio Applicazione ---
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}