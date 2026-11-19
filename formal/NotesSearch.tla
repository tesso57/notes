---------------------------- MODULE NotesSearch ----------------------------
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS SlotCount, TopK, QueryLimit, Absent, NoteKeys, QueryKeys,
          NoteEmbedding, QueryEmbedding, Similarity

\* Each live slot is one chunk occurrence in the current documents() order.
\* The slot identifies the current path, line and text in both searches.
\* Multiple slots can share a content hash. The snapshot is fixed while a
\* search runs. Edit can replace or delete a slot, or introduce a new one.
Slots == 1..SlotCount
ASSUME /\ SlotCount \in Nat
       /\ TopK \in Nat
       /\ QueryLimit \in Nat \ {0}
       /\ Absent \notin NoteKeys
       /\ DOMAIN NoteEmbedding = NoteKeys
       /\ DOMAIN QueryEmbedding = QueryKeys

VARIABLES corpus, cachedNotes, cachedQueries, queryOrder
vars == <<corpus, cachedNotes, cachedQueries, queryOrder>>

Live == {i \in Slots : corpus[i] # Absent}
CurrentKeys == {corpus[i] : i \in Live}
Keys(seq) == {seq[i] : i \in DOMAIN seq}

\* Hashes stand for exact chunk texts and trimmed queries, without collisions
\* among distinct inputs in each map. NoteEmbedding and QueryEmbedding are
\* fixed functions of the key for the model identity, across runs and batches.
\* Similarity maps embedding pairs to ordered scores, with no NaN.
\* Each accepted disk or memory hit must contain the canonical vector. The
\* implementation checks version/model and vector shape, not this provenance.
ResolveVector(cache, canonical, key) ==
    IF key \in DOMAIN cache THEN cache[key] ELSE canonical[key]

Fill(cache, canonical, keys) ==
    [key \in keys |-> ResolveVector(cache, canonical, key)]

Sound(cache, canonical) ==
    \A key \in DOMAIN cache : cache[key] = canonical[key]

Scores(noteVector, queryVector) ==
    [i \in Live |-> Similarity[<<queryVector, noteVector[corpus[i]]>>]]

Precedes(scores, j, i) ==
    \/ scores[j] > scores[i]
    \/ scores[j] = scores[i] /\ j < i

Rank(scores, i) == 1 + Cardinality({j \in Live : Precedes(scores, j, i)})

\* A set of (occurrence, rank, score) triples encodes the ordered result.
\* Descending score with an ascending slot tie-break models the stable sort
\* of the current chunks and the final slice. Sparse slots preserve order.
Top(scores) ==
    {<<i, Rank(scores, i), scores[i]>> : i \in {j \in Live : Rank(scores, j) <= TopK}}

ReusedResult(q) ==
    Top(Scores(Fill(cachedNotes, NoteEmbedding, CurrentKeys),
               ResolveVector(cachedQueries, QueryEmbedding, q)))

RecomputedResult(q) == Top(Scores(NoteEmbedding, QueryEmbedding[q]))
SameResults == \A q \in QueryKeys : ReusedResult(q) = RecomputedResult(q)

Empty == [k \in {} |-> k]

Init ==
    /\ corpus = [i \in Slots |-> Absent]
    /\ cachedNotes = Empty
    /\ cachedQueries = Empty
    /\ queryOrder = <<>>

Edit(i, key) ==
    /\ corpus' = [corpus EXCEPT ![i] = key]
    /\ UNCHANGED <<cachedNotes, cachedQueries, queryOrder>>

ClearCache ==
    /\ cachedNotes' = Empty
    /\ cachedQueries' = Empty
    /\ queryOrder' = <<>>
    /\ UNCHANGED corpus

Touch(q) ==
    LET recent == Append(SelectSeq(queryOrder, LAMBDA h : h # q), q)
    IN IF Len(recent) > QueryLimit THEN Tail(recent) ELSE recent

\* Search starts from a sound cache snapshot and uses the current chunks.
\* Pruning and refill use CurrentKeys, so a removed occurrence cannot be
\* returned. Query eviction abstracts Map insertion order as a sequence.
\* Empty searches skip embedding the query. Only successful runs are modeled.
\* Batching, persistence, filesystem errors and concurrent scans are abstracted.
Search(q) ==
    /\ UNCHANGED corpus
    /\ cachedNotes' = Fill(cachedNotes, NoteEmbedding, CurrentKeys)
    /\ IF Live = {}
          THEN UNCHANGED <<cachedQueries, queryOrder>>
          ELSE /\ queryOrder' = Touch(q)
               /\ cachedQueries' = Fill(cachedQueries, QueryEmbedding, Keys(queryOrder'))

Next ==
    \/ \E i \in Slots, key \in NoteKeys \cup {Absent} : Edit(i, key)
    \/ ClearCache
    \/ \E q \in QueryKeys : Search(q)

Spec == Init /\ [][Next]_vars

CacheSound ==
    /\ Sound(cachedNotes, NoteEmbedding)
    /\ Sound(cachedQueries, QueryEmbedding)

CacheShape ==
    /\ corpus \in [Slots -> NoteKeys \cup {Absent}]
    /\ DOMAIN cachedNotes \subseteq NoteKeys
    /\ DOMAIN cachedQueries = Keys(queryOrder)
    /\ queryOrder \in Seq(QueryKeys)
    /\ Len(queryOrder) <= QueryLimit
    /\ Cardinality(Keys(queryOrder)) = Len(queryOrder)

=============================================================================
