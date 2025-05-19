# Midigram: Visualizzatore MIDI Completo

**Un'applicazione web per l'analisi, la visualizzazione e l'interazione con file MIDI.**

Questo progetto si è evoluto da un semplice visualizzatore frontend a una soluzione completa che utilizza un backend Python per un'analisi MIDI robusta e un frontend JavaScript per un rendering grafico dettagliato dello spartito tramite VexFlow. Offre la possibilità di visualizzare partiture da file MIDI e include funzionalità di base per esercizi interattivi (richiede input MIDI esterno o simulato).

## Funzionalità

*   Caricamento e analisi di file MIDI (`.mid`, `.midi`).
*   Estrazione e visualizzazione di metadati (Time Signature, Key Signature).
*   Rendering grafico dello spartito (Chiave di Violino e Chiave di Basso).
*   Gestione delle alterazioni individuali sulle note.
*   Gestione degli accordi: un accordo viene assegnato al rigo di basso se la nota più bassa è sotto il Do centrale (MIDI 60), altrimenti al rigo di violino.
*   Pausa di misura intera disegnata automaticamente per i righi completamente vuoti.
*   Legature (Beams) automatiche generate solo per sequenze di note consecutive discendenti.
*   Esportazione dello spartito visualizzato come immagine PNG.
*   Interfaccia utente per caricare file e controllare (Avvia/Ferma) un ipotetico esercizio di lettura/esecuzione.
*   Display di accuratezza per l'esercizio (richiede input MIDI esterno o simulato).
*   Slider per controllare la "velocità di scorrimento" (attualmente un indicatore visivo nell'interfaccia).

## Tecnologie Utilizzate

*   **Backend:** Python (Flask)
    *   `music21`: Per l'analisi avanzata dei file MIDI.
    *   `Flask-Cors`: Per gestire le richieste cross-origin tra frontend e backend.
*   **Frontend:** HTML, CSS, JavaScript
    *   `VexFlow`: Per il rendering degli spartiti musicali in formato SVG.
    *   `html2canvas`: Per la cattura dello spartito SVG e l'esportazione in PNG.

## Setup e Avvio del Progetto

Per eseguire questo progetto in locale, segui questi passaggi:

1.  **Clona il Repository:**
    ```bash
    git clone https://github.com/thc792/midigram.git
    cd midigram
    ```

2.  **Configura il Backend Python:**
    *   È altamente raccomandato l'uso di un ambiente virtuale. Se non ne hai uno, crealo:
        ```bash
        python -m venv .venv
        # Oppure python3 -m venv .venv su alcuni sistemi
        ```
    *   Attiva l'ambiente virtuale:
        *   Su Windows: `.\.venv\Scripts\activate`
        *   Su macOS/Linux: `source ./.venv/bin/activate`
    *   Installa le dipendenze Python dal file `requirements.txt`:
        ```bash
        pip install -r requirements.txt
        ```

3.  **Avvia il Backend:**
    *   Assicurati che l'ambiente virtuale sia attivo.
    *   Avvia il server Flask:
        ```bash
        flask --app app run --debug
        # Il server si avvierà su http://127.0.0.1:5000
        ```
    *   Lascia questo terminale aperto per mantenere il backend in esecuzione.

4.  **Avvia il Frontend:**
    *   Apri il file `index.html` nel tuo browser web (Firefox, Chrome, Edge, ecc.). Puoi farlo direttamente dal file system (`file:///percorso/del/tuo/progetto/index.html`) o, se preferisci, il server di sviluppo di Flask serve anche i file statici, quindi puoi accedervi tramite l'indirizzo del backend (`http://127.0.0.1:5000/index.html`).
    *   Per un'esperienza ottimale e per evitare problemi di CORS (anche se Flask-Cors è abilitato), l'accesso tramite `http://127.0.0.1:5000/index.html` potrebbe essere preferibile.

5.  **Utilizzo:**
    *   Una volta caricata la pagina, utilizza il pulsante "Carica File MIDI" per selezionare un file `.mid` o `.midi`.
    *   Il file verrà inviato al backend per l'analisi e lo spartito verrà visualizzato nell'area sottostante.
    *   I pulsanti "Avvia/Riprova" e "Ferma" sono implementati per un esercizio di lettura/esecuzione. Attualmente, l'input dell'utente deve essere simulato tramite la console del browser (`simulateMidiInput(midiNumber)`) o integrato con una vera sorgente MIDI (richiede implementazione aggiuntiva della Web MIDI API).
    *   Il display "Accuratezza" tiene traccia delle note corrette nell'esercizio.
    *   Il pulsante "Esporta PNG" ti permette di salvare lo spartito visualizzato.

## Esercizio Interattivo (Note sull'Input MIDI)

La funzionalità di esercizio (`Avvia/Riprova`, `Ferma`, `Accuratezza`) è pronta per ricevere input MIDI per verificare se l'utente suona le note corrette rispetto alla partitura. Tuttavia, **l'integrazione diretta con tastiere MIDI tramite Web MIDI API non è attualmente inclusa** nel codice fornito.

Per testare l'esercizio, puoi utilizzare la console di sviluppo del tuo browser e chiamare la funzione globale `simulateMidiInput(midiNumber)`. Ad esempio, per simulare la pressione di un Do centrale (MIDI 60), apri la console e digita:

```javascript
simulateMidiInput(60);
Licenza
Il codice originale di questo progetto è Copyright © 2024 lorenzetti giuseppe. Tutti i diritti sono riservati.
Le librerie di terze parti VexFlow e music21 sono utilizzate sotto le rispettive licenze (MIT e BSD 3-Clause).
Per i dettagli completi sulle licenze, si prega di fare riferimento al file LICENSE nella directory principale del repository.
Contatti
Per domande o supporto, puoi contattare l'autore:
Nome: lorenzetti giuseppe
Email: pianothc791@gmail.com
Sito Web di Riferimento: pianohitech.com
