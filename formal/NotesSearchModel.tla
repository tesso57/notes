------------------------- MODULE NotesSearchModel ----------------------------
EXTENDS NotesSearch, Integers

\* Vectors 1, 2, 3 represent e1, e2, -e1. Cosine scores are exact integers.
ModelNoteKeys == 1..2
ModelQueryKeys == 1..3
ModelNoteEmbedding == [k \in ModelNoteKeys |-> k]
ModelQueryEmbedding == [q \in ModelQueryKeys |-> q]

ModelSimilarity ==
    [pair \in {<<q, n>> : q \in ModelQueryKeys, n \in ModelNoteKeys} |->
        CASE pair[1] = pair[2] -> 1
          [] pair = <<3, 1>> -> -1
          [] OTHER -> 0]

\* Negative control: use INIT WrongVectorsInit, NEXT Next, INVARIANT
\* SameResults in place of SPECIFICATION and INVARIANTS in the TLC config.
\* Both cache entries have a valid vector, with their provenance swapped.
WrongVectorsInit ==
    /\ corpus = [i \in Slots |-> IF i \in ModelNoteKeys THEN i ELSE Absent]
    /\ cachedNotes = [k \in ModelNoteKeys |-> 3 - k]
    /\ cachedQueries = Empty
    /\ queryOrder = <<>>

=============================================================================
