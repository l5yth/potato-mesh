# Copyright © 2025-26 l5yth & contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# frozen_string_literal: true

require "spec_helper"
require_relative "support/federation_fake_peers"

# One instance row per domain, replaced atomically (SPEC FK1, FK2):
# +upsert_instance_record+ reads the row stored for the domain, evicts it
# and inserts the new record in one IMMEDIATE transaction, or in a savepoint
# when the handle already holds a transaction, so a failed insert keeps the
# evicted row and a concurrent write for the domain waits for the lock
# instead of failing on +idx_instances_domain+; and a database error while a
# crawl stores one entry is logged and the crawl goes on.
RSpec.describe "Federation instance records" do
  include_context "fake federation peers"

  let(:peers) { FederationFakePeers }
  let(:application) { FederationFakePeers::APP }
  let(:domain) { "genuine.fed.invalid" }
  let(:old_key) { peers::KEYS["fk-old-key"] }
  let(:new_key) { peers::KEYS["fk-new-key"] }
  let(:third_key) { peers::KEYS["fk-third-key"] }
  # A row written by the transaction a caller already holds.
  let(:outer_row) { ["outer.fed.invalid", "outer-pem"] }

  # Domain and public key of every stored row, by domain.
  #
  # @return [Array<Array(String, String)>] domain and public key.
  def stored_keys
    stored_rows.map { |row| row.first(2) }
  end

  # Store, through +db+, the record of {#domain} under +key+.
  #
  # @param db [SQLite3::Database] open database handle.
  # @param key [OpenSSL::PKey::RSA] the instance key.
  # @return [void]
  def upsert(db, key)
    attributes = peers.attrs(domain, key)
    application.upsert_instance_record(db, attributes, peers.sign(key, attributes))
  end

  # Make +db+ raise +error+ in place of the instances INSERT.
  #
  # @param db [SQLite3::Database] open database handle.
  # @param error [Exception] what the INSERT raises.
  # @return [void]
  def fail_instance_insert(db, error)
    allow(db).to receive(:execute).and_call_original
    allow(db).to receive(:execute).with(a_string_starting_with("INSERT INTO instances"), anything).and_raise(error)
  end

  # Write {#outer_row} through +db+.
  #
  # @param db [SQLite3::Database] open database handle.
  # @return [void]
  def insert_outer_row(db)
    db.execute("INSERT INTO instances (id, domain, pubkey) VALUES ('outer', ?, ?)", outer_row)
  end

  # Pause the statement on +db+ that starts with +prefix+, before it runs
  # or after it ran, until +release+ is pushed (at most 5 s), and push the
  # statement to +reached+ when the pause starts. With +fail_insert+ the
  # instances INSERT raises instead of running.
  #
  # @param db [SQLite3::Database] open database handle.
  # @param prefix [String] start of the statement to pause at.
  # @param at [Symbol] +:before+ or +:after+ the statement.
  # @param reached [Queue] told when the pause starts.
  # @param release [Queue] ends the pause.
  # @param fail_insert [Boolean] whether the instances INSERT raises.
  # @return [void]
  def pause_statement(db, prefix, at:, reached:, release:, fail_insert: false)
    allow(db).to receive(:execute).and_wrap_original do |original, sql, *rest, &block|
      if fail_insert && sql.start_with?("INSERT INTO instances")
        raise SQLite3::FullException, "spec: database or disk is full"
      end

      paused = sql.start_with?(prefix)
      if paused && at == :before
        reached << sql
        release.pop(timeout: 5)
      end
      result = original.call(sql, *rest, &block)
      if paused && at == :after
        reached << sql
        release.pop(timeout: 5)
      end
      result
    end
  end

  # Run +action+ on a thread and kill it once it pauses. The thread is
  # killed, released and reaped on every path, a pause that never comes
  # included, so none is left behind holding the write lock.
  #
  # @param reached [Queue] told when the thread pauses.
  # @param release [Queue] ends the pause.
  # @return [String, nil] the statement it paused at, nil when it never
  #   paused within 5 s.
  def kill_at_pause(reached, release, &action)
    writer = Thread.new(&action)
    paused_at = reached.pop(timeout: 5)
    writer.kill
    paused_at
  ensure
    if writer
      writer.kill
      release << true
      writer.join(5)
    end
  end

  # Make the instances INSERT on +db+ end the open transaction and then
  # raise, as SQLite does when it rolls back on its own after
  # +SQLITE_FULL+ or +SQLITE_IOERR+.
  #
  # @param db [SQLite3::Database] open database handle.
  # @return [void]
  def roll_back_and_fail_instance_insert(db)
    allow(db).to receive(:execute).and_wrap_original do |original, sql, *rest, &block|
      if sql.start_with?("INSERT INTO instances")
        original.call("ROLLBACK TRANSACTION")
        raise SQLite3::FullException, "spec: database or disk is full"
      end
      original.call(sql, *rest, &block)
    end
  end

  describe "the row of a domain is replaced in one transaction (FK1)" do
    it "keeps the evicted row when the insert after the eviction fails" do
      with_db { |db| upsert(db, old_key) }

      with_db do |db|
        fail_instance_insert(db, SQLite3::FullException.new("spec: database or disk is full"))

        expect { upsert(db, new_key) }.to raise_error(SQLite3::FullException, "spec: database or disk is full")
        expect(db.transaction_active?).to be(false)
      end

      expect(stored_keys).to eq([[domain, old_key.public_key.to_pem]])
    end

    describe "a kill at any point leaves no transaction or savepoint open" do
      # Where the writer is killed, and which key the domain's row holds
      # afterwards: the stored one, or the new one once the commit ran.
      {
        "right after BEGIN" => { prefix: "BEGIN IMMEDIATE TRANSACTION", at: :after, kept: :old },
        "before the insert" => { prefix: "INSERT INTO instances", at: :before, kept: :old },
        "right after COMMIT" => { prefix: "COMMIT TRANSACTION", at: :after, kept: :new },
        "before the rollback of a failed insert" => {
          prefix: "ROLLBACK TRANSACTION", at: :before, kept: :old, fail_insert: true,
        },
      }.each do |point, kill|
        it "keeps the domain's row whole when the writer is killed #{point}" do
          with_db { |db| upsert(db, old_key) }
          reached = Queue.new
          release = Queue.new

          with_db do |db|
            pause_statement(
              db, kill[:prefix], at: kill[:at], reached: reached, release: release,
                                 fail_insert: kill.fetch(:fail_insert, false),
            )

            expect(kill_at_pause(reached, release) { upsert(db, new_key) }).to start_with(kill[:prefix])
            expect(db.transaction_active?).to be(false)
          end

          kept = kill[:kept] == :new ? new_key : old_key
          expect(stored_keys).to eq([[domain, kept.public_key.to_pem]])
        end
      end

      it "leaves only the caller's transaction open when the writer is killed right after SAVEPOINT" do
        with_db { |db| upsert(db, old_key) }
        reached = Queue.new
        release = Queue.new

        with_db do |db|
          db.execute("BEGIN IMMEDIATE TRANSACTION")
          pause_statement(db, "SAVEPOINT", at: :after, reached: reached, release: release)

          expect(kill_at_pause(reached, release) { upsert(db, new_key) }).to eq("SAVEPOINT instance_record")
          expect(db.transaction_active?).to be(true)
          expect { db.execute("RELEASE SAVEPOINT instance_record") }.to raise_error(SQLite3::SQLException, /no such savepoint/)
          db.execute("ROLLBACK TRANSACTION")
        end

        expect(stored_keys).to eq([[domain, old_key.public_key.to_pem]])
      end
    end

    it "makes a write for the domain wait between the read and the insert instead of failing on the domain index" do
      with_db { |db| upsert(db, old_key) }
      allow(PotatoMesh::Config).to receive(:db_busy_max_retries).and_return(0)
      outcomes = []

      with_db do |first|
        with_db do |second|
          second.busy_timeout = 50
          # The second registration runs once the first has read and
          # evicted, right before the first inserts.
          allow(first).to receive(:execute).and_wrap_original do |original, sql, *rest, &block|
            if sql.start_with?("INSERT INTO instances") && outcomes.empty?
              begin
                upsert(second, third_key)
                outcomes << :stored
              rescue SQLite3::Exception => e
                outcomes << e.class
              end
            end
            original.call(sql, *rest, &block)
          end

          upsert(first, new_key)
          expect(outcomes).to eq([SQLite3::BusyException])
          expect(stored_keys).to eq([[domain, new_key.public_key.to_pem]])

          # Once the first has committed, the second evicts its row in turn.
          upsert(second, third_key)
        end
      end

      expect(stored_keys).to eq([[domain, third_key.public_key.to_pem]])
    end

    it "replaces the row inside a savepoint when the handle already holds a transaction" do
      with_db { |db| upsert(db, old_key) }

      with_db do |db|
        db.transaction(:immediate) do
          insert_outer_row(db)
          upsert(db, new_key)

          expect(db.transaction_active?).to be(true)
        end
      end

      expect(stored_keys).to eq([[domain, new_key.public_key.to_pem], outer_row])
    end

    it "rolls back only its savepoint when its insert fails inside the caller's transaction" do
      with_db { |db| upsert(db, old_key) }

      with_db do |db|
        db.transaction(:immediate) do
          insert_outer_row(db)
          fail_instance_insert(db, SQLite3::FullException.new("spec: database or disk is full"))

          expect { upsert(db, new_key) }.to raise_error(SQLite3::FullException)
          expect(db.transaction_active?).to be(true)
        end
      end

      expect(stored_keys).to eq([[domain, old_key.public_key.to_pem], outer_row])
    end

    it "raises the insert's own error when SQLite already rolled the transaction back" do
      with_db { |db| upsert(db, old_key) }

      with_db do |db|
        roll_back_and_fail_instance_insert(db)

        expect { upsert(db, new_key) }.to raise_error(SQLite3::FullException, "spec: database or disk is full")
        expect(db.transaction_active?).to be(false)
      end

      expect(stored_keys).to eq([[domain, old_key.public_key.to_pem]])
    end

    it "raises the insert's own error when SQLite already ended the caller's transaction" do
      with_db { |db| upsert(db, old_key) }

      with_db do |db|
        db.execute("BEGIN IMMEDIATE TRANSACTION")
        insert_outer_row(db)
        roll_back_and_fail_instance_insert(db)

        expect { upsert(db, new_key) }.to raise_error(SQLite3::FullException, "spec: database or disk is full")
        expect(db.transaction_active?).to be(false)
      end

      expect(stored_keys).to eq([[domain, old_key.public_key.to_pem]])
    end
  end

  describe "a crawl goes on after a database error on one entry (FK2)" do
    let(:root) { "root.fed.invalid" }
    let(:next_root) { "next.fed.invalid" }
    let(:broken) { "broken.fed.invalid" }
    let(:healthy) { "healthy.fed.invalid" }

    it "logs the entry it could not store and crawls the next entry and the next root" do
      fed.lists[root] = [peers.record(broken), peers.record(healthy)]
      fed.lists[next_root] = []
      allow(application).to receive(:federation_target_domains).and_return([root, next_root])
      allow(application).to receive(:upsert_instance_record).and_wrap_original do |original, db, attributes, signature|
        raise SQLite3::IOException, "spec: disk I/O error" if attributes[:domain] == broken

        original.call(db, attributes, signature)
      end

      application.crawl_federation!

      expect(stored_rows.map(&:first)).to eq([healthy])
      expect(log_lines("Failed to persist remote instance").map(&:last)).to eq(
        [{
          context: "federation.instances", domain: broken,
          error_class: "SQLite3::IOException", error_message: "spec: disk I/O error",
        }],
      )
      expect(fed.counts(healthy)).to eq(instances: 1, well_known: 1, nodes_acceptance: 1)
      expect(fed.counts(next_root)).to eq(instances: 1)
      expect(log_lines("Federation crawl complete").size).to eq(1)
    end

    it "logs a constraint error on a nested entry and walks the rest of that list" do
      fed.lists[root] = [peers.record(healthy)]
      fed.lists[healthy] = [peers.record(broken), peers.record(next_root)]
      allow(application).to receive(:upsert_instance_record).and_wrap_original do |original, db, attributes, signature|
        if attributes[:domain] == broken
          raise SQLite3::ConstraintException, "spec: UNIQUE constraint failed: instances.domain"
        end

        original.call(db, attributes, signature)
      end

      crawl(root)

      expect(stored_rows.map(&:first)).to eq([healthy, next_root])
      expect(log_lines("Failed to persist remote instance").map { |line| line.last[:error_class] }).to eq(
        ["SQLite3::ConstraintException"],
      )
    end
  end
end
