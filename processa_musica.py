# processa_musica.py

# Importa i moduli necessari da music21
try:
    from music21 import note, stream, converter
    print("Moduli music21 importati con successo!")
except ImportError:
    print("Errore: music21 non trovato. Assicurati che l'ambiente virtuale (.venv) sia attivo.")
    exit() # Esci dallo script se music21 non può essere importato

print("\n--- Test base di music21 ---")

# Creiamo una nota semplice (Do centrale, ottava 4)
try:
    nota_c4 = note.Note("C4")
    print(f"Creata nota: {nota_c4.nameWithOctave}")

    # Creiamo un piccolo stream (una sequenza di eventi musicali)
    partitura_semplice = stream.Stream()
    partitura_semplice.append(nota_c4)
    partitura_semplice.append(note.Note("D4"))
    partitura_semplice.append(note.Note("E4"))

    print(f"Creato stream con {len(partitura_semplice.elements)} elementi (note).")

    # Esempio: Stampa il nome di ogni elemento nello stream
    print("Elementi nello stream:")
    for elemento in partitura_semplice:
        if isinstance(elemento, note.Note): # Controlliamo se è una nota
            print(f"  Nota: {elemento.nameWithOctave}")
        # Potresti aggiungere controlli per altri tipi di elementi (accordi, pause, ecc.)

except Exception as e:
    print(f"Si è verificato un errore durante il test base: {e}")


print("\n--- Fine dello script ---")