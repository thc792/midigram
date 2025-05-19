from flask import Flask, request, jsonify
from flask_cors import CORS
from music21 import converter, stream, note, chord, duration
from music21 import configure
import base64
import io
import traceback
import os
import tempfile

NOTE_SPLIT_POINT = 60
DEFAULT_PPQ = 480

app = Flask(__name__)
CORS(app)

@app.route('/', methods=['GET'])
def index():
    return "Backend music21 attivo e funzionante! Invia un file MIDI (POST) alla rotta /process_midi."

@app.route('/process_midi', methods=['POST'])
def process_midi():
    print("\n--- Ricevuta richiesta POST su /process_midi ---")

    data = request.json
    if not data or 'midiData' not in data or not data['midiData']:
        print("Errore: Dati MIDI 'midiData' mancanti o vuoti.")
        return jsonify({"error": "Nessun dato MIDI inviato o formato JSON non valido."}), 400

    temp_file_path = None

    try:
        base64_string_with_header = data['midiData']
        if ',' in base64_string_with_header:
            header, base64_string = base64_string_with_header.split(',', 1)
        else:
             base64_string = base64_string_with_header

        midi_bytes = base64.b64decode(base64_string)

        temp_file = tempfile.NamedTemporaryFile(delete=False, suffix='.mid', mode='wb')
        temp_file.write(midi_bytes)
        temp_file.close()
        temp_file_path = temp_file.name

        print(f"Inizio analisi music21 da file temporaneo '{os.path.basename(temp_file_path)}'...")
        midi_stream = converter.parse(temp_file_path, format='midi')
        print("Analisi MIDI con music21 completata.")

        extracted_metadata = {}
        extracted_notes_list = []
        note_id_counter = 0

        time_sig_obj = midi_stream.flat.getElementsByClass('TimeSignature')
        if time_sig_obj:
            try:
                numerator = time_sig_obj[0].numerator
                denominator = time_sig_obj[0].denominator
                extracted_metadata['timeSignature'] = f"{numerator}/{denominator}"
            except Exception as ts_e:
                print(f"ATTENZIONE: Errore estrazione TimeSignature: {ts_e}. Uso default 4/4.")
                extracted_metadata['timeSignature'] = "4/4"
        else:
            extracted_metadata['timeSignature'] = "4/4"

        key_sig_name = "C"
        try:
            key_analysis = midi_stream.analyze('key')
            if key_analysis:
                 vexflow_key_name = key_analysis.tonic.name
                 if key_analysis.mode == 'minor':
                     vexflow_key_name += 'm'
                 key_sig_name = vexflow_key_name
                 print(f"DEBUG: Key Signature estratta (analisi music21): {key_sig_name}")
        except Exception as key_analyze_e:
             print(f"ATTENZIONE: Errore analisi Key Signature con music21: {key_analyze_e}. Uso default C.")

        extracted_metadata['keySignature'] = key_sig_name

        tempo_elements = midi_stream.flat.getElementsByClass(['TempoIndication', 'MetronomeMark'])
        found_qpm = None
        for el in tempo_elements:
            try:
                current_qpm = el.getQuarterNotesPerMinute()
                if current_qpm is not None and current_qpm > 0:
                    found_qpm = current_qpm
                    break
            except AttributeError:
                pass

        if found_qpm is not None:
            extracted_metadata['tempo'] = int(60000000 / found_qpm)
            print(f"DEBUG: Tempo estratto: {found_qpm} QPM ({extracted_metadata['tempo']} micros/QN)")
        else:
            extracted_metadata['tempo'] = 500000
            print(f"ATTENZIONE: Tempo non trovato. Uso default: 120 QPM ({extracted_metadata['tempo']} micros/QN)")

        extracted_metadata['ppq'] = DEFAULT_PPQ
        print(f"DEBUG: PPQ usato (default): {DEFAULT_PPQ}")


        for element in midi_stream.flat.notesAndRests:

            try:
                 original_ticks = int(round(element.offset * extracted_metadata.get('ppq', DEFAULT_PPQ)))
                 duration_ticks = int(round(element.duration.quarterLength * extracted_metadata.get('ppq', DEFAULT_PPQ)))
            except Exception as calc_e:
                 print(f"ATTENZIONE: Errore calcolo ticks/duration per elemento a offset {element.offset}: {calc_e}")
                 original_ticks = 0
                 duration_ticks = 1

            if isinstance(element, note.Note):
                print(f"DEBUG NOTE: Offset={element.offset}, Ticks={original_ticks}, MIDI={element.pitch.midi}, Name={element.pitch.nameWithOctave}")
                if element.pitch.accidental:
                    print(f"DEBUG NOTE:   Accidental Type={getattr(element.pitch.accidental, 'type', 'N/A')}, Alter={getattr(element.pitch.accidental, 'alter', 'N/A')}, DisplayStatus={getattr(element.pitch.accidental, 'displayStatus', 'N/A')}")

                accidental_type = None
                if element.pitch and element.pitch.accidental:
                    try:
                        if hasattr(element.pitch.accidental, 'type') and element.pitch.accidental.type != 'natural':
                             if element.pitch.accidental.type == 'sharp':
                                 accidental_type = '#'
                             elif element.pitch.accidental.type == 'flat':
                                 accidental_type = 'b'
                             elif element.pitch.accidental.type == 'double-sharp':
                                 accidental_type = '##'
                             elif element.pitch.accidental.type == 'double-flat':
                                 accidental_type = 'bb'
                             else:
                                 accidental_type = element.pitch.accidental.type

                        elif hasattr(element.pitch.accidental, 'alter') and element.pitch.accidental.alter != 0:
                             alter_value = element.pitch.accidental.alter
                             if alter_value == -1:
                                 accidental_type = 'b'
                             elif alter_value == 1:
                                 accidental_type = '#'
                             elif alter_value == -2:
                                 accidental_type = 'bb'
                             elif alter_value == 2:
                                 accidental_type = '##'
                             elif alter_value == 0:
                                 pass

                    except Exception as acc_e:
                        print(f"ATTENZIONE: Errore estrazione accidental (type/alter) per nota a offset {element.offset}: {acc_e}")

                print(f"DEBUG NOTE:   Extracted accidental_type={accidental_type}")

                extracted_notes_list.append({
                    'id': f'note-{note_id_counter}',
                    'midi': element.pitch.midi,
                    'ticks': original_ticks,
                    'durationTicks': duration_ticks,
                    'track': 0, 'channel': 0,
                    'velocity': element.volume.velocity if element.volume.velocity is not None else 64,
                    'accidental': accidental_type,
                    'noteNameWithOctave': element.pitch.nameWithOctave
                })
                note_id_counter += 1

            elif isinstance(element, chord.Chord):
                print(f"DEBUG CHORD: Offset={element.offset}, Ticks={original_ticks}, Pitches={[p.nameWithOctave for p in element.pitches]}")

                for single_note_in_chord in element.notes:
                     print(f"DEBUG CHORD NOTE:   MIDI={single_note_in_chord.pitch.midi}, Name={single_note_in_chord.pitch.nameWithOctave}")
                     if single_note_in_chord.pitch.accidental:
                         print(f"DEBUG CHORD NOTE:     Accidental Type={getattr(single_note_in_chord.pitch.accidental, 'type', 'N/A')}, Alter={getattr(single_note_in_chord.pitch.accidental, 'alter', 'N/A')}, DisplayStatus={getattr(single_note_in_chord.pitch.accidental, 'displayStatus', 'N/A')}")

                     accidental_type = None
                     if single_note_in_chord.pitch and single_note_in_chord.pitch.accidental:
                         try:
                             if hasattr(single_note_in_chord.pitch.accidental, 'type') and single_note_in_chord.pitch.accidental.type != 'natural':
                                 if single_note_in_chord.pitch.accidental.type == 'sharp':
                                     accidental_type = '#'
                                 elif single_note_in_chord.pitch.accidental.type == 'flat':
                                     accidental_type = 'b'
                                 elif single_note_in_chord.pitch.accidental.type == 'double-sharp':
                                     accidental_type = '##'
                                 elif single_note_in_chord.pitch.accidental.type == 'double-flat':
                                     accidental_type = 'bb'
                                 else:
                                     accidental_type = single_note_in_chord.pitch.accidental.type

                             elif hasattr(single_note_in_chord.pitch.accidental, 'alter') and single_note_in_chord.pitch.accidental.alter != 0:
                                 alter_value = single_note_in_chord.pitch.accidental.alter
                                 if alter_value == -1:
                                     accidental_type = 'b'
                                 elif alter_value == 1:
                                     accidental_type = '#'
                                 elif alter_value == -2:
                                     accidental_type = 'bb'
                                 elif alter_value == 2:
                                     accidental_type = '##'
                                 elif alter_value == 0:
                                     pass

                         except Exception as acc_e:
                             print(f"ATTENZIONE: Errore estrazione accidental (type/alter) per nota in accordo a offset {element.offset}: {acc_e}")

                     print(f"DEBUG CHORD NOTE:     Extracted accidental_type={accidental_type}")

                     extracted_notes_list.append({
                        'id': f'note-{note_id_counter}',
                        'midi': single_note_in_chord.pitch.midi,
                        'ticks': original_ticks,
                        'durationTicks': duration_ticks,
                        'track': 0, 'channel': 0,
                        'velocity': getattr(single_note_in_chord.volume, 'velocity', element.volume.velocity if element.volume.velocity is not None else 64),
                        'accidental': accidental_type,
                        'noteNameWithOctave': single_note_in_chord.pitch.nameWithOctave
                     })
                     note_id_counter += 1

        extracted_notes_list.sort(key=lambda x: (x['ticks'], x.get('midi', 0)))

        print(f"Estrazione completata. Trovate {len(extracted_notes_list)} note individuali/d'accordo.")

        response_data = {
            "metadata": extracted_metadata,
            "allParsedNotes": extracted_notes_list
        }

        print("Risposta JSON per il frontend preparata.")
        return jsonify(response_data)

    except Exception as e:
        print(f"\n!!! Errore CRITICO durante l'elaborazione MIDI nel backend: {e}")
        traceback.print_exc()

        error_response = {
            "error": f"Errore interno del server durante l'elaborazione MIDI: {e}",
            "detail": traceback.format_exc()
        }
        print("Invio risposta di errore 500 al frontend.")
        return jsonify(error_response), 500

    finally:
        if temp_file_path and os.path.exists(temp_file_path):
            try:
                os.remove(temp_file_path)
                print(f"DEBUG: File temporaneo cancellato: {temp_file_path}")
            except Exception as e:
                print(f"ATTENZIONE: Impossibile cancellare file temporaneo {temp_file_path}: {e}")

if __name__ == '__main__':
    print("\n--- Avvio server Flask di sviluppo ---")
    app.run(debug=True, port=5000, host='127.0.0.1')