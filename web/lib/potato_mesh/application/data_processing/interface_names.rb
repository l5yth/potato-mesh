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

module PotatoMesh
  module App
    module DataProcessing
      # Reticulum interface names without peer addresses (SPEC RI1-RI3).
      #
      # RNS prints several interface classes with the address of their peer
      # or socket, such as +TCPInterface[Client on Public Hub/203.0.113.77:51234]+
      # for a TCP server's peer, and +GET /api/destinations+ serves the stored
      # name to anyone, +PRIVATE=1+ included.  The ingestor posts the name
      # without its address (+public_interface_name+ in
      # +data/mesh_ingestor/protocols/reticulum_interfaces.py+).  This copy of
      # the rule scrubs every record on write, so an older ingestor cannot
      # store an address, and the rows stored before, once at boot
      # ({DataProcessing#scrub_destination_interfaces}).  Both copies are
      # checked against the cases in
      # +tests/fixtures/reticulum_interface_names.tsv+.
      module InterfaceNames
        # Printed class prefixes of names that end with an address (RNS
        # 1.5.7), each mapped to the text that comes before the address:
        # +TCPInterface+ (+TCPClientInterface+, a TCP server's peers included),
        # +TCPServerInterface+, +BackboneInterface+ (the server and its
        # clients), +UDPInterface+ and +AutoInterfacePeer+ end
        # +/<address>]+; an +I2PInterfacePeer+ that connects out is named
        # +<I2PInterface name> to <peer>+.
        ADDRESS_PREFIXES = {
          "TCPInterface" => "/",
          "TCPServerInterface" => "/",
          "BackboneInterface" => "/",
          "UDPInterface" => "/",
          "AutoInterfacePeer" => "/",
          "I2PInterfacePeer" => " to ",
        }.freeze

        # Printed class prefixes whose brackets hold the peer's address alone.
        BARE_ADDRESS_PREFIXES = %w[WeaveInterfacePeer].freeze

        # Printed class prefixes of names that hold no address (RNS 1.5.7).
        # +Shared Instance+ is how +LocalServerInterface+ prints, and
        # +LocalInterface[rns/default]+ names a socket.  An
        # +RNodeSubInterface+ prints +<parent>[<sub>]+; see {CLASS_NAME}.
        NAME_PREFIXES = [
          "AutoInterface", "AX25KISSInterface", "I2PInterface", "KISSInterface",
          "LocalInterface", "PipeInterface", "RNodeInterface", "RNodeMultiInterface",
          "SerialInterface", "Shared Instance", "WeaveInterface",
        ].freeze

        # What an address after each separator looks like.  After +/+: no
        # whitespace, and a colon (+host:port+, an IPv6 address).  After
        # +" to "+: an I2P peer, a name ending +.i2p+ (any ASCII case of +i+
        # and +p+) or a base64 destination.  A name segment that looks like
        # neither is never taken for one, which keeps {.public_name}
        # idempotent.  Explicit ASCII classes and no +/i+, which would fold
        # U+212A (Kelvin) and U+017F (long s) into +[A-Za-z]+ where the
        # Python copy's +re.ASCII+ does not.
        ADDRESSES = {
          "/" => /\A\S*:\S*\z/,
          " to " => /\A(?:\S+\.[iI]2[pP]|[A-Za-z0-9~-]{500,}={0,2})\z/,
        }.freeze

        # An unknown prefix that names an interface class, as an external
        # module's does.  An +RNodeSubInterface+ prints +<parent>[<sub>]+ with
        # its +RNodeMultiInterface+'s operator-given name as +<parent>+: a
        # prefix that is no identifier, or that holds "rnode" in any case, is
        # taken for that name, and RNode names are never cut.
        CLASS_NAME = /\A[A-Za-z_][A-Za-z0-9_]*\z/

        # Name {DataProcessing#scrub_destination_interfaces} gives
        # {.public_name} as a SQL function.
        SQL_FUNCTION = "potato_public_interface_name"

        module_function

        # Return a printed interface name without its peer address (SPEC RI1).
        #
        # The name keeps its class prefix and the operator-given name, and
        # loses the address, along with the brackets when nothing is left in
        # them.  An address-printing class drops each trailing +/<address>+
        # or, for an I2P peer, +" to <peer>"+, so
        # +TCPInterface[Hub A/B/203.0.113.77:4242]+ becomes
        # +TCPInterface[Hub A/B]+; a Weave peer becomes its class; a name-only
        # class and an RNode sub-interface are unchanged; an unknown class
        # ({.external_class?}) whose bracket text holds +/+ keeps the text
        # before its first +/+, which is where dropping the text after the
        # last +/+ ends when repeated.  A name the 256-byte SL3 cap
        # ({FieldLimits::INTERFACE_BYTES}, applied before this rule) cut
        # before its closing +]+ drops, for an address-printing class, the
        # text after its last separator.  Applying it to its own result
        # changes nothing.
        #
        # @param value [Object] interface name as RNS printed it, or any value.
        # @return [Object] the name without its address, or +value+ itself
        #   when it is no string or not of the form +<class>[...+.
        def public_name(value)
          return value unless value.is_a?(String)

          head, bracket, rest = value.partition("[")
          return value if bracket.empty?
          return head if BARE_ADDRESS_PREFIXES.include?(head)

          separator = ADDRESS_PREFIXES[head]
          return value if separator.nil? && !external_class?(head)

          closed = rest.end_with?("]")
          text = closed ? rest[0...-1] : rest
          if separator.nil?
            kept = text.partition("/").first
          else
            kept = text
            kept = kept.rpartition(separator).first if !closed && kept.include?(separator)
            # +scrub+: a regexp raises on invalid UTF-8, which a stored row
            # read at boot could hold.
            kept = kept.rpartition(separator).first while kept.include?(separator) && ADDRESSES[separator].match?(kept.rpartition(separator).last.scrub)
          end
          return value if kept == text

          kept.empty? ? head : "#{head}[#{kept}]"
        end

        # Report whether a printed prefix belongs to an unknown interface class.
        #
        # @param head [String] text before the first +[+ of a printed name.
        # @return [Boolean] true for an identifier without "rnode" that no
        #   known class prints; false for a known class and for an RNode
        #   multi-interface's name ({CLASS_NAME}).
        def external_class?(head)
          !NAME_PREFIXES.include?(head) && CLASS_NAME.match?(head.scrub) && !head.downcase.include?("rnode")
        end
      end

      # Remove peer addresses from the stored +destinations.interface+ values
      # (SPEC RI3).
      #
      # Rows written before SPEC RI2 hold printed names with addresses, and the
      # upsert keeps a stored interface when a record omits it, so they would
      # stay served.  One +UPDATE+ applies {InterfaceNames.public_name},
      # registered as a SQL function, to every row whose value it changes; it
      # runs at every boot, called from the +configure+ block right after
      # +ensure_schema_upgrades+, and since the rule is idempotent a second run
      # changes no row.  A database error, such as a missing table, logs a
      # warning and the boot goes on.
      #
      # @return [Integer, nil] rows rewritten, or nil when the update failed.
      def scrub_destination_interfaces
        db = open_database
        db.create_function(InterfaceNames::SQL_FUNCTION, 1) do |func, value|
          func.result = InterfaceNames.public_name(value)
        end
        rows = with_busy_retry do
          # The LIKE terms pick the candidates in SQL, so the function runs
          # only for a name with a "/", a Weave peer's or an I2P peer's.
          db.execute(<<~SQL)
            UPDATE destinations SET interface = #{InterfaceNames::SQL_FUNCTION}(interface)
             WHERE (interface LIKE '%/%' OR interface LIKE 'WeaveInterfacePeer[%'
                    OR interface LIKE 'I2PInterfacePeer[%')
               AND #{InterfaceNames::SQL_FUNCTION}(interface) IS NOT interface
          SQL
          db.changes
        end
        info_log("Removed peer addresses from stored interface names", context: "database.schema", rows: rows) if rows.positive?
        rows
      rescue SQLite3::Exception => e
        warn_log(
          "Failed to remove peer addresses from stored interface names",
          context: "database.schema",
          error_class: e.class.name,
          error_message: e.message,
        )
        nil
      ensure
        db&.close
      end
    end
  end
end
