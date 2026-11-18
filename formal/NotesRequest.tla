---------------------------- MODULE NotesRequest ----------------------------
EXTENDS Naturals

CONSTANT MaxEpoch
VARIABLES epoch, stopped, noteRun, idle, queued, reading, sent, errors

vars == <<epoch, stopped, noteRun, idle, queued, reading, sent, errors>>

\* index.ts: requestNote advances the epoch and checks the queue before
\* preparing a request. reading holds unresolved attempts, including older
\* attempts whose cancellation has not settled. Path validation and either
\* procedure failure share ReadFailed. Parallel reads are one batch here.
\* sent and errors record dispatches and request error notifications.
\* The model uses exact counters and abstracts away filesystem cancellation
\* and timing, host/UI failures, command warnings and session-start errors.
\* Pi processing after dispatch, model output and writes are out of scope.
Init ==
    /\ epoch = 0
    /\ stopped = FALSE
    /\ noteRun = FALSE
    /\ idle = TRUE
    /\ queued = FALSE
    /\ reading = {}
    /\ sent = {}
    /\ errors = {}

Ready == ~stopped /\ idle /\ ~queued

BeginRequest ==
    /\ epoch' = epoch + 1
    /\ reading' = IF Ready THEN reading \cup {epoch + 1} ELSE reading

ManualRequest ==
    /\ idle
    /\ BeginRequest
    /\ UNCHANGED <<stopped, noteRun, idle, queued, sent, errors>>

AgentSettled(aborted) ==
    /\ noteRun' = FALSE
    /\ IF stopped \/ noteRun \/ aborted
          THEN UNCHANGED <<epoch, reading>>
          ELSE BeginRequest
    /\ UNCHANGED <<stopped, idle, queued, sent, errors>>

\* Session start and shutdown, and the before_agent_start hook.
StartSession ==
    /\ epoch' = epoch + 1
    /\ stopped' = FALSE
    /\ noteRun' = FALSE
    /\ UNCHANGED <<idle, queued, reading, sent, errors>>

StopSession ==
    /\ epoch' = epoch + 1
    /\ stopped' = TRUE
    /\ UNCHANGED <<noteRun, idle, queued, reading, sent, errors>>

StartTurn(isNote) ==
    /\ epoch' = epoch + 1
    /\ noteRun' = isNote
    /\ UNCHANGED <<stopped, idle, queued, reading, sent, errors>>

\* The input, switch, fork, compact and tree hooks all advance the epoch.
Invalidate ==
    /\ epoch' = epoch + 1
    /\ UNCHANGED <<stopped, noteRun, idle, queued, reading, sent, errors>>

SetQueue(isIdle, hasMessages) ==
    /\ idle' = isIdle
    /\ queued' = hasMessages
    /\ UNCHANGED <<epoch, stopped, noteRun, reading, sent, errors>>

\* The post-await checks through sendMessage form one synchronous step.
\* Synchronous listeners are assumed not to reenter the Pi lifecycle or
\* change idle/queued during dispatch.
ReadSucceeded(ticket) ==
    /\ ticket \in reading
    /\ reading' = reading \ {ticket}
    /\ sent' = IF Ready /\ epoch = ticket
                  THEN sent \cup {ticket}
                  ELSE sent
    /\ UNCHANGED <<epoch, stopped, noteRun, idle, queued, errors>>

ReadFailed(ticket) ==
    /\ ticket \in reading
    /\ reading' = reading \ {ticket}
    /\ errors' = IF ~stopped /\ epoch = ticket
                    THEN errors \cup {ticket}
                    ELSE errors
    /\ UNCHANGED <<epoch, stopped, noteRun, idle, queued, sent>>

Next ==
    \/ ManualRequest
    \/ \E aborted \in BOOLEAN : AgentSettled(aborted)
    \/ StartSession
    \/ StopSession
    \/ \E isNote \in BOOLEAN : StartTurn(isNote)
    \/ Invalidate
    \/ \E isIdle, hasMessages \in BOOLEAN : SetQueue(isIdle, hasMessages)
    \/ \E ticket \in reading : ReadSucceeded(ticket)
    \/ \E ticket \in reading : ReadFailed(ticket)

Spec == Init /\ [][Next]_vars

\* A ticket can be dispatched or report an error at most once.
Safety ==
    /\ epoch \in Nat
    /\ reading \cap (sent \cup errors) = {}
    /\ sent \cap errors = {}
    /\ \A ticket \in reading \cup sent \cup errors : ticket \in 1..epoch

FreshDispatch ==
    /\ sent \subseteq sent'
    /\ \A ticket \in sent' \ sent :
        /\ ticket \in reading
        /\ ticket = epoch
        /\ Ready

FreshError ==
    /\ errors \subseteq errors'
    /\ \A ticket \in errors' \ errors :
        /\ ticket \in reading
        /\ ticket = epoch
        /\ ~stopped

ReadyAtStart ==
    reading' \ reading # {} => Ready

NoAutomaticRetry ==
    \A aborted \in BOOLEAN :
        AgentSettled(aborted) /\ (noteRun \/ stopped \/ aborted) =>
            UNCHANGED <<epoch, reading>>

DispatchSafety == [][FreshDispatch]_vars
ErrorSafety == [][FreshError]_vars
PreparationSafety == [][ReadyAtStart]_vars
RetrySafety == [][NoAutomaticRetry]_vars

\* Only TLC bounds the epoch. The proof covers arbitrary natural epochs.
ModelBound == epoch <= MaxEpoch

=============================================================================
