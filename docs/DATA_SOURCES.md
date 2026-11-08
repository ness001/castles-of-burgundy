# Numeric reference data

Rules: https://www.yucata.de/en/Rules/CastlesOfBurgundy

Primary rulebook for the full-coverage pass: the original rulebook at https://cdn.1j1ju.com/medias/04/f5/f9-the-castles-of-burgundy-rulebook.pdf. Pages 2–4 establish setup/rounds, 5–9 actions and scoring, 10–11 knowledge, and 12 optional original-estate setup. The implementation and help paraphrase rules; rulebook artwork/text is not embedded in the application.

Important printed erratum: English page 9 says *fewest* empty spaces in a tied score, but https://www.yucata.de/en/Rules/CastlesOfBurgundy explicitly corrects this to *most*. The original German rule at https://www.yucata.de/de/Rules/CastlesOfBurgundy agrees (“mehr leere Felder”). The game therefore preserves **most empty estate spaces**, then later on the final turn-order track. The first English translation error is not reproduced.

Original German primary source independently verified online: https://www.brettspiele-report.de/images/d/die_burgen_von_burgund/Spielanleitung_Die_Burgen_von_Burgund.pdf (©2011 Ravensburger; the hosting page states publisher permission). Pages 9–11 confirm most-empty tie-break, knowledge 6's normal silver purchase from all seven depots, knowledge 15's three VP and knowledge 26's two VP. These remain the default Original 2011 profile.

Optional **Special Edition rule changes** use the four printed differences in the user-provided Special Edition reference and its publisher PDF: https://awakenrealms.com/images/download/CoB/CoB_Rulebook_285x210mm%20%5B28%20pages%5D.pdf. Page 11 gives knowledge 6's once-per-turn two-worker numbered-depot building acquisition; page 12 gives knowledge 15 two VP and knowledge 26 three VP; page 10 prints fewest-empty tie-break. The menu deliberately labels these as rule changes, not full Special Edition support: original board inventory, setup choices and no-expansion scope are retained. No claim is made that original-edition errata override Special Edition's printed rules.

Original estates #1–9 numeric colors and dice: https://github.com/mangorine/Burgundy/tree/main/images/boards. All 333 printed cells were checked; the numeric dice arrangement is shared. Physical front/back pairs (#1/#2, #1/#3, #1/#4, #1/#5, #6/#7, #8/#9) corroborated by the “Base Game Boards / Backed by” listing at http://www.fwtwr.com/fwtwr/cob/boards.asp. Only numeric facts, not source images, are shipped. `src/boards.ts` owns these facts.

Three/four-player depot slots cross-checked with the rulebook's game-board diagram and https://github.com/ultimate271/Castles/blob/master/src/builtin.hs. The three-player sixth depot changes its castle to a mine only in phases B and D; four-player setup keeps that castle. Black-depot counts are 4/6/8; goods sales score 2/3/4 per tile and first/second color bonuses are 5/2, 6/3, 7/4.

Board #1 numeric cells and two-player depot colors cross-checked with https://github.com/ultimate271/Castles/blob/master/src/builtin.hs and original board #1 reference at https://github.com/mangorine/Burgundy/blob/main/images/boards/board1.jpg. No artwork shipped. Rule text and all rendering code independently authored. Knowledge building mapping checked against rule illustrations.

Livestock supply cross-check: https://github.com/ProperNovice/BurgundyBoard/blob/master/src/controller/TileManager.java — per animal: normal 2,2,3,3,4; black 3,4. Black knowledge: 7,12,14,15,24,25, also corroborated by its numbered component image inventory. Only component facts were transcribed; no Java code or images reused. No edition-expansion data included.

BSD reference license (retained for numeric-table reference):

Copyright Author name here (c) 2017

All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.

    * Redistributions in binary form must reproduce the above
      copyright notice, this list of conditions and the following
      disclaimer in the documentation and/or other materials provided
      with the distribution.

    * Neither the name of Author name here nor the names of other
      contributors may be used to endorse or promote products derived
      from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
